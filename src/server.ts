import * as z from 'zod';
import * as os from "os";
import path from "path";
import * as fs from "fs/promises";
import * as udp from 'dgram';
import {RemoteInfo, Socket} from 'dgram';
import {split} from "split-cmd";

// Due to execa being a ESM module it needs to be done through a dynamic import. And we need to extract out the actual
// execa fucntion from the returned object
import('execa').then(({execa}) => {

    /**
     * The valid locations for a configuration on the machine. The linux based path is removed if the platform is not
     * identified as linux
     */
    const CONFIG_PATHS: string[] = [
        os.platform() === 'linux' ? '/etc/ents/terminal-config.json' : undefined,
        os.platform() === 'linux' ? path.join('~', '.terminal-server.config.json') : undefined,
        path.join(__dirname, '..', 'config', 'config.json'),
    ].filter((e) => e !== undefined) as string[];

    /**
     * Zod valdiator for configuration objects which ensures that commands are valid (alphanumeric and -) and that
     * definitions are valid. bind and ports are required
     */
    const CONFIG_VALIDATOR = z.object({
        bind: z.string(),
        port: z.number(),
        commands: z.record(z.string().regex(/^[a-zA-Z0-9]+$/), z.object({
            execute: z.string(),
            schema: z.string().optional(),
        })),
    });
    type ConfigType = z.infer<typeof CONFIG_VALIDATOR>;

    /**
     * The active configuration loaded from file. The type is a refined version of that generated from zod, replacing
     * the `schema: string` to be a RegExp object
     */
    let activeConfiguration: Omit<ConfigType, 'commands'> & {
        commands: Record<string, Omit<ConfigType['commands'][string], 'schema'> & { schema?: RegExp }>
    };

    /**
     * Attempts to load a configuration from one of the paths defined in {@link CONFIG_PATHS}. It wil try each path,
     * starting from the top and moving down attempting to load the file from disk, parse it as JSON and then validate
     * it, including parsing as RegExp for any provided schemas.
     */
    async function loadConfiguration() {
        let config: typeof activeConfiguration | undefined = undefined;

        for (const file of CONFIG_PATHS) {
            let content;

            // Try and read file from disk
            try {
                content = await fs.readFile(file, {encoding: 'utf8'});
            } catch (e) {
                console.warn(`Could not load configuration file ${file} due to an error: ${e}`)
                continue;
            }

            // Parse it as JSON and fail it out if its not
            try {
                content = JSON.parse(content);
            } catch (e) {
                console.warn(`Failed to load the JSON data at path ${file} due to error: ${e}`);
                continue;
            }

            // Try and parse it as a config file and reject if the file was not valid with the zod errors7
            // Try and be as helpful with the output as possible
            let safeParse = CONFIG_VALIDATOR.safeParse(content);
            if (!safeParse.success) {
                const reasons = safeParse.error.message + safeParse.error.errors.map((e) => `${e.message} (@ ${e.path.join('.')}`).join(', ');
                console.warn(`Content in ${file} is not valid: ${reasons}`);
                continue;
            }

            try {
                // For each of the commands, we want to try and replace the schema with a parsed regex if it exists and
                // handle any errors if they are present.
                const parsedCommands = Object.fromEntries(Object.entries(safeParse.data.commands).map(([key, value]) => {
                    return [
                        key,
                        {
                            execute: value.execute,
                            schema: value.schema ? new RegExp(value.schema) : undefined,
                        }
                    ];
                }));

                // Rebuild the config file with the new commands
                config = {
                    ...safeParse.data,
                    commands: parsedCommands,
                };

                console.log(`loaded configuration successfully from ${file}`);
            } catch (e) {
                throw new Error('Failed to load configuration because the regex schema was not valid: ' + e);
            }
        }

        // If the config was never loaded (ie every available path failed) then just throw an error and fail
        if (config === undefined) {
            throw new Error(`Failed to load configuration as no valid file was found at the following locations: ${CONFIG_PATHS.join(',')}`);
        }

        // Save the new configuration
        activeConfiguration = config;
    }

    /**
     * Execute as a command with the given set of substitutions to put into the command string
     * @param socket the socket on which the response should be sent
     * @param target the target to which the response should be sent, should be the source of the message
     * @param command the command which should be executed, this should be loaded from the configuration file
     * @param substitutions the key value pairs of substitution keys and values
     */
    async function executeCommand(socket: Socket, target: RemoteInfo, command: string, substitutions?: Record<string, string>) {
        // Use command split to divide it up as bash would which will make sure we maintain the command splits despite
        // the substitutions
        const divided = split(command);

        // If substitutions were provided, then go through every value and replace them all. There might be a
        // vulnerability here that the keys are interpreted as regex but this is not super relevant right now. In the
        // entire string, substitute every value
        if (substitutions) {
            for (let i = 0; i < divided.length; i++) {
                for (const [key, value] of Object.entries(substitutions)) {
                    divided[i] = divided[i].replace(new RegExp(`{{${key}}}`, 'g'), value);
                }
            }
        }

        console.log('  executing command');
        console.log('     ', divided);

        // Then try and run it and send the output of the command back to the client or return a successful response
        try {
            const {stdout} = await execa(divided[0], divided.slice(1));
            socket.send(`ok:${stdout}`, target.port, target.address);

            console.log('  received stdout');
            console.log(stdout.split('\n').map((e) => '     ' + e).join('\n'));
        } catch (e) {
            socket.send(`er:${e}`, target.port, target.address);

            console.log('  received error');
            console.log(e);
        }
    }

    /**
     * Handle an incoming message from the UDP server, requires the socket to send responses on.
     * @param socket the socket on which the message was received or on which the response should be sent
     * @param message the message that was received
     * @param info the info of the client sending the message, used to form the target of the response
     */
    function handleIncoming(socket: Socket, message: Buffer, info: RemoteInfo) {
        // Convert it back into a string, assuming a utf8 encoding
        const data = message.toString('utf8');
        // The command delimeter is : so if its not present, its not valid
        if (!data.includes(':')) {
            console.warn(`Command ignored because it did not contain the command delimiter: ${data}`);
            socket.send(`er:invalid command`, info.port, info.address);
            return;
        }

        // Divide the command into its is command portion and its parameters and then try and look it up in the
        // configuration file
        const command = data.substring(0, data.indexOf(':'));
        const parameters = data.substring(data.indexOf(':') + 1);
        const lookup = activeConfiguration.commands[command];

        // If the command was not found send an error response to the client
        if (!lookup) {
            console.warn(`Ignoring command ${command} because it did not match any records`);
            socket.send(`er:unknown command`, info.port, info.address);
            return;
        }

        // If a schema was not provided then just execute the command with no additional subsitutions
        if (!lookup.schema) {
            void executeCommand(socket, info, lookup.execute);
            return;
        }

        // Otherwise try and execute the regex against the parameters to see if they are valid
        const match = lookup.schema.exec(parameters);

        // If not reject the instruction because it is malformed
        if (!match) {
            console.warn(`Not executing command ${command} (${lookup.execute}) because regex didn't match`);
            socket.send(`er:invalid params`, info.port, info.address);
            return;
        }

        // If groups aren't provided, the substitutions can't take place - this system relies on named groups to make
        // things explicit and safe
        if (!match.groups) {
            console.warn(`Not executing command ${command} (${lookup.execute}) because named groups are not in use`);
            socket.send(`er:invalid regex`, info.port, info.address);
            return;
        }

        // Then finally the groups are valid and we can substitute the values in and execute it
        void executeCommand(socket, info, lookup.execute, match.groups);
    }

    // When ready for launch, load the configurations
    // Create a UDPv4 server and then add a handler for the messages to handleIncoming
    // Then bind it to the port and address. If it fails just bail out
    loadConfiguration().then(() => {
        let socket = udp.createSocket('udp4');
        socket.on('message', (msg, rinfo) => handleIncoming(socket, msg, rinfo));
        socket.bind(activeConfiguration.port, activeConfiguration.bind);
    }).catch((e) => {
        console.error('Failed to launch as no configuration could be found');
        console.error('  ' + e.message);
    })
});
