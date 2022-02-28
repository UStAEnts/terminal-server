"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const z = __importStar(require("zod"));
const os = __importStar(require("os"));
const path_1 = __importDefault(require("path"));
const fs = __importStar(require("fs/promises"));
const udp = __importStar(require("dgram"));
const split_cmd_1 = require("split-cmd");
import('execa').then(({ execa }) => {
    const CONFIG_PATHS = [
        os.platform() === 'linux' ? '/etc/ents/terminal-config.json' : undefined,
        path_1.default.join(__dirname, '..', 'config', 'config.json'),
    ].filter((e) => e !== undefined);
    const CONFIG_VALIDATOR = z.object({
        bind: z.string(),
        port: z.number(),
        commands: z.record(z.string().regex(/^[a-zA-Z0-9]+$/), z.object({
            execute: z.string(),
            schema: z.string().optional(),
        })),
    });
    let activeConfiguration;
    function loadConfiguration() {
        return __awaiter(this, void 0, void 0, function* () {
            let config = undefined;
            for (const file of CONFIG_PATHS) {
                let content;
                try {
                    content = yield fs.readFile(file, { encoding: 'utf8' });
                }
                catch (e) {
                    continue;
                }
                try {
                    content = JSON.parse(content);
                }
                catch (e) {
                    console.warn(`Failed to load the JSON data at path ${config} due to error: ${e}`);
                    continue;
                }
                let safeParse = CONFIG_VALIDATOR.safeParse(content);
                if (!safeParse.success) {
                    console.warn(`Content in ${config} is not valid: ${safeParse.error.format()}`);
                    continue;
                }
                try {
                    const parsedCommands = Object.fromEntries(Object.entries(safeParse.data.commands).map(([key, value]) => {
                        return [
                            key,
                            {
                                execute: value.execute,
                                schema: value.schema ? new RegExp(value.schema) : undefined,
                            }
                        ];
                    }));
                    config = Object.assign(Object.assign({}, safeParse.data), { commands: parsedCommands });
                }
                catch (e) {
                    throw new Error('Failed to load configuration because the regex schema was not valid: ' + e);
                }
            }
            if (config === undefined) {
                throw new Error(`Failed to load configuration as no valid file was found at the following locations: ${CONFIG_PATHS.join(',')}`);
            }
            activeConfiguration = config;
        });
    }
    function send(socket, target, info) {
        socket.send(info, target.port, target.address);
    }
    function executeCommand(socket, target, command, substitutions) {
        return __awaiter(this, void 0, void 0, function* () {
            const divided = (0, split_cmd_1.split)(command);
            if (substitutions) {
                for (let i = 0; i < divided.length; i++) {
                    for (const [key, value] of Object.entries(substitutions)) {
                        divided[i] = divided[i].replace(new RegExp(`{{${key}}}`, 'g'), value);
                    }
                }
            }
            try {
                const { stdout } = yield execa(divided[0], divided.slice(1));
                send(socket, target, `ok:${stdout}`);
            }
            catch (e) {
                send(socket, target, `er:${e}`);
            }
        });
    }
    function handleIncoming(socket, message, info) {
        const data = message.toString('utf8');
        if (!data.includes(':')) {
            console.warn(`Command ignored because it did not contain the command delimiter: ${data}`);
            send(socket, info, `er:invalid command`);
            return;
        }
        const command = data.substring(0, data.indexOf(':'));
        const parameters = data.substring(data.indexOf(':') + 1);
        const lookup = activeConfiguration.commands[command];
        if (!lookup) {
            console.warn(`Ignoring command ${command} because it did not match any records`);
            send(socket, info, `er:unknown command`);
            return;
        }
        if (!lookup.schema) {
            executeCommand(socket, info, lookup.execute);
            return;
        }
        const match = lookup.schema.exec(parameters);
        if (!match) {
            console.warn(`Not executing command ${command} (${lookup.execute}) because regex didn't match`);
            send(socket, info, `er:invalid params`);
            return;
        }
        if (!match.groups) {
            console.warn(`Not executing command ${command} (${lookup.execute}) because named groups are not in use`);
            send(socket, info, `er:invalid regex`);
            return;
        }
        executeCommand(socket, info, lookup.execute, match.groups);
    }
    loadConfiguration().then(() => {
        let socket = udp.createSocket('udp4');
        socket.on('message', (msg, rinfo) => handleIncoming(socket, msg, rinfo));
        socket.bind(activeConfiguration.port, activeConfiguration.bind);
    }).catch((e) => {
        console.error('Failed to launch as no configuration could be found');
        console.error('  ' + e.message);
    });
});
