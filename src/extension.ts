import { LanguageClient, ServerOptions, LanguageClientOptions, StreamInfo } from 'vscode-languageclient'

import * as vscode from 'vscode'
import { spawn } from 'child_process'
import { existsSync, mkdir, mkdirSync } from 'fs'
import { basename, dirname } from 'path'
import * as net from 'net'

const LanguageID = 'php'

let languageClient: LanguageClient

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    if (process.platform === 'win32') {
        vscode.window.showWarningMessage('Phpactor is not supported on Windows.')
        return
    }

    let workspaceConfig = vscode.workspace.getConfiguration()
    const config = workspaceConfig.get('phpactor') as any
    const enable = config.enable

    if (!config.path) {
        config.path = await installPhpactor(context.globalStoragePath)
    }

    if (enable === false) return

    languageClient = createClient(config)
    languageClient.start()
}

export function deactivate(): Promise<void> | undefined {
    if (!languageClient) {
        return undefined
    }
    return languageClient.stop()
}

function getServerOptions(config): ServerOptions {
    let serverOptions
    if (!config.remote.enabled) {
        // launch language server via stdio
        serverOptions = {
            run: {
                command: config.path,
                args: ['language-server', ...config.launchServerArgs],
            },
            debug: {
                command: 'phpactor',
                args: ['language-server', ...config.launchServerArgs],
            },
        }
    } else {
        // credits: https://github.com/itemis/xtext-languageserver-example/blob/master/vscode-extension/src/extension.ts
        // launch language server via socket
        serverOptions = () => {
            let { host, port } = config.remote
            let socket = net.connect({
                host,
                port,
            })

            let result = /*<StreamInfo>*/ {
                writer: socket,
                reader: socket,
            }

            return Promise.resolve(result)
        }
    }

    return serverOptions
}

function createClient(config: any): LanguageClient {
    let serverOptions = getServerOptions(config)

    let clientOptions: LanguageClientOptions = {
        documentSelector: [
            { language: LanguageID, scheme: 'file' },
            { language: 'blade', scheme: 'file' },
            { language: LanguageID, scheme: 'untitled' },
        ],
        initializationOptions: config.config,
    }

    languageClient = new LanguageClient('phpactor', 'Phpactor Language Server', serverOptions, clientOptions)

    vscode.commands.registerCommand('phpactor.reindex', reindex)
    vscode.commands.registerCommand('phpactor.config.dump', dumpConfig)
    vscode.commands.registerCommand('phpactor.services.list', servicesList)
    vscode.commands.registerCommand('phpactor.status', status)
    const updateConfig = { cwd: dirname(dirname(config.path)) }
    vscode.commands.registerCommand('phpactor.update', updatePhpactor, updateConfig)

    return languageClient
}

function reindex(): void {
    if (!languageClient) {
        return
    }

    languageClient.sendRequest('indexer/reindex')
}

async function dumpConfig(): Promise<void> {
    if (!languageClient) {
        return
    }

    const channel = vscode.window.createOutputChannel('Phpactor Config')
    const result = await languageClient.sendRequest<string>('phpactor/debug/config', { return: true })
    channel.append(result)
    channel.show()
}

function servicesList(): void {
    if (!languageClient) {
        return
    }

    languageClient.sendRequest('service/running')
}

async function status(): Promise<any> {
    if (!languageClient) {
        return
    }

    const channel = vscode.window.createOutputChannel('Phpactor Status')
    const result = await languageClient.sendRequest<string>('phpactor/status')
    channel.append(result)
    channel.show()
}

async function installPhpactor(storagePath: string): Promise<string> {
    if (!existsSync(storagePath)) {
        mkdirSync(storagePath)
    }

    const path = `${storagePath}/phpactor`

    if (!existsSync(path)) {
        const channel = vscode.window.createOutputChannel('Phpactor Installation')
        vscode.window.showInformationMessage('Installing Phpactor')
        await exec(channel, 'git', ['clone', 'https://github.com/phpactor/phpactor', '--depth=1'], storagePath)
        await exec(channel, 'composer', ['install', '--no-dev'], path)
        vscode.window.showInformationMessage(`Phpactor installed at ${path}`)
    }

    return `${storagePath}/phpactor/bin/phpactor`
}

export async function updatePhpactor(): Promise<void> {
    const channel = vscode.window.createOutputChannel('Phpactor Update')
    channel.appendLine(this.cwd)
    await exec(channel, 'git', ['pull'], this.cwd)
    await exec(channel, 'composer', ['install', '--no-dev'], this.cwd)
    channel.appendLine('Phpactor updated')
    vscode.window.showInformationMessage('Phpactor updated')
}

function exec(channel: vscode.OutputChannel, command: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            timeout: 30000,
        })
        child.stdout.on('data', data => {
            channel.append(data.toString('utf8'))
        })
        child.stderr.on('data', data => {
            channel.append(data.toString('utf8'))
        })
        child.on('close', code => {
            if (code !== 0) {
                reject(`Expected git to exit with code 0 got "${code}"`)
            }
            resolve()
        })

        child.on('error', err => {
            reject(err)
        })
    })
}
