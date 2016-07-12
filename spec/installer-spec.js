import test from 'ava';
import path from 'path';
import { readdir, stat } from 'fs-extra-p'
import { createWindowsInstaller } from '../src/index.js';
import { Promise } from 'bluebird';
import temp from 'temp';

temp.track();

const createTempDir = Promise.promisify(temp.mkdir);

const log = require('debug')('electron-windows-installer:spec');

const appDirectory = path.join(__dirname, 'fixtures/app');

test('creates a nuget package and installer', async t => {
  const outputDirectory = await createTempDir('ei-');

  const options = {
    title: 'MyApp',
    name: 'myapp',
    appDirectory: appDirectory,
    outputDirectory: outputDirectory,
    version: '1.0.0',
    description: 'test',
    iconUrl: 'https://boo'
  };

  await createWindowsInstaller(options);

  log(`Verifying assertions on ${outputDirectory}`);
  log(JSON.stringify(await readdir(outputDirectory)))

  t.true((await stat(path.join(outputDirectory, 'myapp-1.0.0-full.nupkg'))).isFile())
  t.true((await stat(path.join(outputDirectory, 'MyAppSetup.exe'))).isFile())

  if (process.platform === 'win32') {
    t.true((await stat(path.join(outputDirectory, 'MyAppSetup.msi'))).isFile())
  }

  log('Verifying Update.exe');
  t.true((await stat(path.join(appDirectory, 'Update.exe'))).isFile());
});
