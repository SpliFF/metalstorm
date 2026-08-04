// Spawns one `spring-server --headless-run` process and waits for it to
// exit. The engine's headless mode self-terminates (server_main.cpp:
// `keepRunning.store(false)` on a stop condition -> normal shutdown ->
// `return 0`) once the run's stop condition fires, so waiting for process
// exit is sufficient — there is no separate "poll until dump appears" step.
//
// Concurrent runs need distinct --port (TCP+UDP bind, no port 0 auto-assign
// in this engine) and --db (SQLite; a shared file would race two writers)
// so every call site must pass both explicitly rather than relying on
// spring-server's built-in defaults.
import { spawn } from 'node:child_process';

export function runHeadless({ serverBin, configPath, port, dbPath, maxWallMin = 5, cwd }) {
    return new Promise((resolve) => {
        const args = [
            '--headless-run', configPath,
            '--port', String(port),
            '--db', dbPath,
            '--max-wall-min', String(maxWallMin),
        ];
        const child = spawn(serverBin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });

        child.on('error', (err) => {
            resolve({ exitCode: null, signal: null, stdout, stderr: stderr + `\nspawn error: ${err.message}` });
        });
        child.on('close', (exitCode, signal) => {
            resolve({ exitCode, signal, stdout, stderr });
        });
    });
}
