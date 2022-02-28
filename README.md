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

## Logging

All commands including `stdout` will be logged to the result. 

## Service

A service file is provided for registering as a constant running service through `systemd`

## Purpose

This is for integration with the Extron system as outlined on [the wiki](https://wiki.entscrew.net) to get around the limitations of the SSH driver.  