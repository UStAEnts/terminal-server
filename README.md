# terminal-server

This repo holds our UDP terminal server which substitutes parameters from a UDP packet into a command specified in the config file.

## Config File

```json
{
  "bind": "0.0.0.0",
  "port": 1234,
  "commands": {
    "demo": {
      "execute": "echo demo"
    },
    "demo-with-params": {
      "execute": "echo demo {{a}}",
      "schema": "(?<a>[a-z]+)"
    }
  }
}
```

The config file contains the commands to be executed and details of the server. The bind and port keys give the address to bind to (ie `0.0.0.0`) for all addresses and port is self explanatory.

Commands are formed on a key which will be included at the start of the UDP packet, and then the value is an object that must contain an `execute` key but can optionally contain a schema. The `execute` key contains what will be executed when the command is issued and can optionally contain parameters.

Parameters are expressed in the form `{{name}}` and relate directly to the schemas. The schemas a `RegExp` expressions containing named capturing groups that will be substituted into the commands. As shown, the command `demo-with-params` will take a lower case alphabetic string and substitute it into the command to form a final output. 

## Packets

Packets are in the format `command:params`. Parameters are defined by the schema regex. To issue a command with no parameters you send `command:`. The colon is always required. For example to execute the two commands shown you would issue packets with `demo:` and `demo:a`. 

## Security

Security is not the main priority of this server so not much effort has been put in to safely escaping and santising input. The onus of avoiding shell injection and other vulnerabilities are left us to the person designing the config to ensure that only suitable characters are whitelisted and it is rigid enough to not support this kind of injection. For example, in the demo config provided above, only a-z characters are allowed to ensure that no shell dividers can be entered. Moreover, hypothetically due to how parameters are passed to `execa`, joined commands should not be possible but I do not have enough confidence in the library or the command splitting library to be able to say this for certain. If you identify any security vulnerabilities or think of any potential mitigations, please open an issue and report it for fixing!

## Logging

All commands including `stdout` will be logged to the result. 

## Service

A service file is provided for registering as a constant running service through `systemd`

## Purpose

This is for integration with the Extron system as outlined on [the wiki](https://wiki.entscrew.net) to get around the limitations of the SSH driver.  
