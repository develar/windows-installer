import test from 'ava';
import path from 'path';
import { readdir } from 'fs-extra-p'
import { createWindowsInstaller, fileExists } from '../src/index.js';
import { Promise } from 'bluebird';
import temp from 'temp';

temp.track();

const createTempDir = Promise.promisify(temp.mkdir);

const log = require('debug')('electron-windows-installer:spec');

const appDirectory = path.join(__dirname, 'fixtures/app');

test('creates a nuget package and installer', async t => {
  const outputDirectory = await createTempDir('ei-');

  const options = {
    appDirectory: appDirectory,
    outputDirectory: outputDirectory
  };

  await createWindowsInstaller(options);

  log(`Verifying assertions on ${outputDirectory}`);
  log(JSON.stringify(await readdir(outputDirectory)))

  t.true(await fileExists(path.join(outputDirectory, 'myapp-1.0.0-full.nupkg')));
  t.true(await fileExists(path.join(outputDirectory, 'MyAppSetup.exe')));

  if (process.platform === 'win32') {
    t.true(await fileExists(path.join(outputDirectory, 'MyAppSetup.msi')));
  }

  log('Verifying Update.exe');
  t.true(await fileExists(path.join(appDirectory, 'Update.exe')));
});
