import { Promise } from 'bluebird';
import { spawn as spawnOg, execFile } from 'child_process';

const debug = require('debug')('electron-windows-installer');

// Public: Maps a process's output into an {Observable}
//
// exe - The program to execute
// params - Arguments passed to the process
//
// Returns an {Observable} with a single value, that is the output of the
// spawned process
export function spawn(exe, params, options) {
  return new Promise((resolve, reject) => {
    debug(`Spawning ${exe} ${params.join(' ')}`);
    const proc = spawnOg(exe, params, Object.assign({
      stdio: debug.enabled ? 'inherit' : ['ignore', 'ignore', 'inherit']
    }, options));

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${exe} failed with exit code: ${code}`));
      }
    });
  });
}

export function exec(file, args) {
  if (debug.enabled) {
    debug(`Executing ${file} ${args == null ? '' : args.join(' ')}`)
  }

  return new Promise((resolve, reject) => {
    execFile(file, args, {maxBuffer: 4 * 1024000}, function (error, stdout, stderr) {
      if (error == null) {
        resolve(stdout)
      }
      else {
        if (stdout.length !== 0) {
          console.log(stdout)
        }
        if (stderr.length === 0) {
          reject(error)
        }
        else {
          reject(new Error(stderr + '\n' + error))
        }
      }
    })
  })
}