import spawn from './spawn-promise';
import asar from 'asar';
import path from 'path';
import { outputFile, fileExists, readFile, copy, mkdirs, rename } from './fs-utils';
import { Promise } from 'bluebird';
import { sign as signCallback } from 'signcode-tf';

const rcedit = Promise.promisify(require('rcedit'));
const log = require('debug')('electron-windows-installer');
const sign = Promise.promisify(signCallback);

export function convertVersion(version) {
  const parts = version.split('-');
  const mainVersion = parts.shift();

  if (parts.length > 0) {
    return [mainVersion, parts.join('-').replace(/\./g, '')].join('-');
  } else {
    return mainVersion;
  }
}

async function computeMetadata(options) {
  const metadata = {
    description: '',
    iconUrl: 'https://raw.githubusercontent.com/atom/electron/master/atom/browser/resources/win/atom.ico'
  };

  if (options.usePackageJson !== false) {
    const appResources = path.join(options.appDirectory, 'resources');
    const asarFile = path.join(appResources, 'app.asar');
    let appMetadata;

    if (await fileExists(asarFile)) {
      appMetadata = JSON.parse(asar.extractFile(asarFile, 'package.json'));
    } else {
      appMetadata = JSON.parse(await readFile(path.join(appResources, 'app', 'package.json'), 'utf8'));
    }

    Object.assign(metadata, {
      exe: `${appMetadata.name}.exe`,
      title: appMetadata.productName || appMetadata.name
    }, appMetadata);
  }

  Object.assign(metadata, options);
  if (metadata.authors == null) {
    if (typeof(metadata.author) === 'string') {
      metadata.authors = metadata.author;
    } else {
      metadata.authors = (metadata.author || {}).name || '';
    }
  }
  return metadata;
}

async function syncReleases(vendorPath, outputDirectory, options) {
  let cmd = path.join(vendorPath, 'SyncReleases.exe');
  let args = ['-u', options.remoteReleases, '-r', outputDirectory];

  if (process.platform !== 'win32') {
    args.unshift(cmd);
    cmd = 'mono';
  }

  if (options.remoteToken) {
    args.push('-t', options.remoteToken);
  }

  await spawn(cmd, args);
}

async function copyUpdateExe(vendorPath, appUpdate, options, rcEditOptions, baseSignOptions) {
  await copy(path.join(vendorPath, 'Update.exe'), appUpdate);
  if (options.setupIcon && (options.skipUpdateIcon !== true)) {
    await rcedit(appUpdate, rcEditOptions);
  }
  await signFile(appUpdate, baseSignOptions);
}

export async function createWindowsInstaller(options) {
  const vendorPath = path.join(__dirname, '..', 'vendor');
  const appUpdate = path.join(options.appDirectory, 'Update.exe');

  const metadata = await computeMetadata(options);
  const rcEditOptions = Object.assign({}, options.rcedit, {
    icon: options.setupIcon
  });

  const rcVersionString = rcEditOptions['version-string'];
  if (rcVersionString != null && rcVersionString.LegalCopyright != null) {
    // rcedit cannot set © symbol (or windows bug?), replace to safe
    rcVersionString.LegalCopyright = rcVersionString.LegalCopyright.replace('©', '(C)');
  }

  const baseSignOptions = options.certificateFile && options.certificatePassword ? Object.assign({
    cert: options.certificateFile,
    password: options.certificatePassword,
    name: metadata.title,
    overwrite: true
  }, options.sign) : null;

  const outputDirectory = path.resolve(options.outputDirectory || 'installer');
  let promises = [
    copyUpdateExe(vendorPath, appUpdate, options, rcEditOptions, baseSignOptions),
    mkdirs(outputDirectory)
  ];
  if (options.remoteReleases) {
    promises.push(syncReleases(vendorPath, outputDirectory, options));
  }

  await Promise.all(promises);
  const version = convertVersion(metadata.version);
  const nupkgPath = path.join(outputDirectory, `${metadata.name}-${version}-full.nupkg`);
  // currently, client move app to lib/net45
  await pack(metadata, path.dirname(path.dirname(options.appDirectory)), nupkgPath, version);
  await releasify(nupkgPath, outputDirectory, options, vendorPath);

  const setupPath = path.join(outputDirectory, 'Setup.exe');

  await rcedit(setupPath, rcEditOptions);

  promises = [signFile(setupPath, baseSignOptions)];
  if (process.platform === 'win32' && options.noMsi !== true) {
    promises.push(signFile(path.join(outputDirectory, 'Setup.msi'), baseSignOptions));
  }
  await Promise.all(promises);

  if (options.fixUpPaths !== false) {
    log('Fixing up paths');

    if (metadata.productName || options.setupExe) {
      const newSetupPath = path.join(outputDirectory, options.setupExe || `${metadata.productName}Setup.exe`);
      log(`Renaming ${setupPath} => ${newSetupPath}`);
      await rename(setupPath, newSetupPath);
    }

    if (metadata.productName) {
      const msiPath = path.join(outputDirectory, `${metadata.productName}Setup.msi`);
      const unfixedMsiPath = path.join(outputDirectory, 'Setup.msi');
      if (await fileExists(unfixedMsiPath)) {
        log(`Renaming ${unfixedMsiPath} => ${msiPath}`);
        await rename(unfixedMsiPath, msiPath);
      }
    }
  }
}

async function signFile(file, baseSignOptions) {
  if (baseSignOptions != null && process.platform !== 'linux') {
    const signOptions = Object.assign({}, baseSignOptions);
    signOptions.path = file;
    await sign(signOptions);
  }
}

async function pack(metadata, directory, outFile, version) {
  const author = metadata.authors || metadata.owners;
  const copyright = metadata.copyright ||
                    `Copyright © ${new Date().getFullYear()} ${author}`;
  const nuspecContent = `<?xml version="1.0"?>
<package xmlns="http://schemas.microsoft.com/packaging/2011/08/nuspec.xsd">
  <metadata>
    <id>${metadata.name}</id>
    <title>${metadata.title}</title>
    <version>${version}</version>
    <authors>${author}</authors>
    <owners>${metadata.owners || metadata.authors}</owners>
    <iconUrl>${metadata.iconUrl}</iconUrl>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
    <description>${metadata.description}</description>
    <copyright>${copyright}</copyright>${metadata.extraMetadataSpecs || ''}
  </metadata>
</package>`;
  log(`Created NuSpec file:\n${nuspecContent}`);

  await Promise.all([
    outputFile(path.join(directory, '_rels', '.rels'), `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="Re0" Target="/${metadata.name}.nuspec" Type="http://schemas.microsoft.com/packaging/2010/07/manifest"/>
<Relationship Id="Re1" Target="/package/services/metadata/core-properties/1.psmdcp" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"/>
</Relationships>`),
    outputFile(path.join(directory, metadata.name + '.nuspec'), nuspecContent),
    outputFile(path.join(directory, '[Content_Types].xml'), `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default ContentType="application/vnd.openxmlformats-package.relationships+xml" Extension="rels"/>
  <Default ContentType="application/octet" Extension="nuspec"/>
  <Default ContentType="application/octet" Extension="pak"/>
  <Default ContentType="application/octet" Extension="asar"/>
  <Default ContentType="application/octet" Extension="bin"/>
  <Default ContentType="application/octet" Extension="dll"/>
  <Default ContentType="application/octet" Extension="exe"/>
  <Default ContentType="application/octet" Extension="dat"/>
  <Default ContentType="application/vnd.openxmlformats-package.core-properties+xml" Extension="psmdcp"/>
  <Default Extension="diff" ContentType="application/octet" />
  <Default Extension="bsdiff" ContentType="application/octet" />
  <Default Extension="shasum" ContentType="text/plain" />
</Types>`),
    outputFile(path.join(directory, 'package', 'services', 'metadata', 'core-properties', '1.psmdcp'), `<?xml version="1.0"?>
<coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                xmlns="http://schemas.openxmlformats.org/package/2006/metadata/core-properties">
  <dc:creator>${author}</dc:creator>
  <dc:description>${metadata.description}</dc:description>
  <dc:identifier>${metadata.name}</dc:identifier>
  <keywords/>
  <lastModifiedBy>NuGet, Version=3.4.0.653, Culture=neutral, PublicKeyToken=31bf3856ad364e35;Unix 15.4.0.0;.NET Framework 4.5</lastModifiedBy>
  <dc:title>${metadata.title}</dc:title>
  <version>${version}</version>
</coreProperties>`)
  ]);

  const spawnOptions = {
    cwd: directory
  }
  if (process.platform === 'win32') {
    await spawn('powershell.exe', ['-nologo', '-noprofile', '-command', `& { Add-Type -A 'System.IO.Compression.FileSystem'; [IO.Compression.ZipFile]::CreateFromDirectory('.', '${outFile}'); }`], spawnOptions)
  }
  else {
    await spawn('zip', ['-rqD9', outFile, '.'], spawnOptions)
  }
}

async function releasify(nupkgPath, outputDirectory, options, vendorPath) {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? path.join(vendorPath, 'Update.com') : 'mono';
  const args = [
    '--releasify', nupkgPath,
    '--releaseDir', outputDirectory,
    '--loadingGif', options.loadingGif ? path.resolve(options.loadingGif) : path.join(__dirname, '..', 'resources', 'install-spinner.gif')
  ];

  if (!isWindows) {
    args.unshift(path.join(vendorPath, 'Update-Mono.exe'));
  }

  if (options.noMsi) {
    args.push('--no-msi');
  }

  await spawn(cmd, args);
}