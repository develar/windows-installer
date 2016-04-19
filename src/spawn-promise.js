import { Promise } from 'bluebird';
import { spawn as spawnOg } from 'child_process';

const d = require('debug')('electron-windows-installer');

// Public: Maps a process's output into an {Observable}
//
// exe - The program to execute
// params - Arguments passed to the process
//
// Returns an {Observable} with a single value, that is the output of the
// spawned process
export default function spawn(exe, params) {
  return new Promise((resolve, reject) => {
    d(`Spawning ${exe} ${params.join(' ')}`);
    const proc = spawnOg(exe, params, {
      stdio: d.enabled ? 'inherit' : ['ignore', 'ignore', 'inherit']
    });

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