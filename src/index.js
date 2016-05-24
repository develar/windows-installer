import spawn from './spawn-promise';
import asar from 'asar';
import path from 'path';
import { Promise } from 'bluebird';
import { sign as signCallback } from 'signcode-tf'
import archiver from 'archiver'
import { stat, readFile, copy, mkdirs, rename, remove, createWriteStream } from 'fs-extra-p'
import archiverUtil from 'archiver-utils'

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

export async function fileExists(file) {
  try {
    return (await stat(file)).isFile()
  } catch(err) {
    log(err);
  }

  return false;
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

function syncReleases(outputDirectory, options) {
  const args = prepareArgs(['-u', options.remoteReleases, '-r', outputDirectory], vendor('SyncReleases.exe'))
  if (options.remoteToken) {
    args.push('-t', options.remoteToken)
  }
  return spawn(process.platform === 'win32' ? vendor('SyncReleases.exe') : 'mono', args)
}

async function copyUpdateExe(appUpdate, options, rcEditOptions, baseSignOptions) {
  await copy(vendor('Update.exe'), appUpdate)
  if (options.setupIcon && (options.skipUpdateIcon !== true)) {
    await rcedit(appUpdate, rcEditOptions)
  }
  await signFile(appUpdate, baseSignOptions)
}

export async function createWindowsInstaller(options) {
  const rcEditOptions = Object.assign({}, options.rcedit, {
    icon: options.setupIcon
  })
  const rcVersionString = rcEditOptions['version-string']
  if (rcVersionString != null && rcVersionString.LegalCopyright != null) {
    // rcedit cannot set © symbol (or windows bug?), replace to safe
    rcVersionString.LegalCopyright = rcVersionString.LegalCopyright.replace('©', '(C)');
  }

  const metadata = await computeMetadata(options)
  const baseSignOptions = options.certificateFile && options.certificatePassword ? Object.assign({
    cert: options.certificateFile,
    password: options.certificatePassword,
    name: metadata.title,
    overwrite: true
  }, options.sign) : null

  const appUpdate = path.join(options.appDirectory, 'Update.exe')
  const outputDirectory = path.resolve(options.outputDirectory || 'installer')
  const promises = [
    copyUpdateExe(appUpdate, options, rcEditOptions, baseSignOptions),
    mkdirs(outputDirectory)
  ];
  if (options.remoteReleases) {
    promises.push(syncReleases(outputDirectory, options));
  }
  await Promise.all(promises)

  const embeddedArchiveFile = path.join(outputDirectory, 'setup.zip')
  const embeddedArchive = archiver('zip')
  const embeddedArchiveOut = createWriteStream(embeddedArchiveFile)
  const embeddedArchivePromise = new Promise(function (resolve, reject) {
    embeddedArchive.on('error', reject)
    embeddedArchiveOut.on('close', resolve)
  })
  embeddedArchive.pipe(embeddedArchiveOut)

  embeddedArchive.file(appUpdate, {name: 'Update.exe'})
  embeddedArchive.file(options.loadingGif ? path.resolve(options.loadingGif) : path.join(__dirname, '..', 'resources', 'install-spinner.gif'), {name: 'background.gif'})

  const version = convertVersion(metadata.version)
  const packageName = `${metadata.name}-${version}-full.nupkg`
  const nupkgPath = path.join(outputDirectory, packageName)
  const setupPath = path.join(outputDirectory, options.setupExe || `${metadata.name || metadata.productName}Setup.exe`)

  await Promise.all([
    pack(metadata, options.appDirectory, nupkgPath, version, options.packageCompressionLevel),
    copy(vendor('Setup.exe'), setupPath),
  ])

  embeddedArchive.file(nupkgPath, {name: packageName})

  await releasify(nupkgPath, outputDirectory)

  const embeddedReleasesFile = path.join(outputDirectory, 'latestRelease')
  embeddedArchive.file(embeddedReleasesFile, {name: 'RELEASES'})
  embeddedArchive.finalize()
  await embeddedArchivePromise

  await writeZipToSetup(setupPath, embeddedArchiveFile)
  await Promise.all([
    rcedit(setupPath, rcEditOptions),
    remove(embeddedReleasesFile),
    remove(embeddedArchiveFile)
  ])

  await signFile(setupPath, baseSignOptions)
  if (options.msi && process.platform === 'win32') {
    await msi(nupkgPath, setupPath)
    await signFile(path.join(outputDirectory, 'Setup.msi'), baseSignOptions)
    if (options.fixUpPaths !== false && metadata.productName) {
      await rename(path.join(outputDirectory, 'Setup.msi'), path.join(outputDirectory, `${metadata.productName}Setup.msi`))
    }
  }
}

function signFile(file, baseSignOptions) {
  if (baseSignOptions != null && process.platform !== 'linux') {
    const signOptions = Object.assign({}, baseSignOptions);
    signOptions.path = file;
    return sign(signOptions);
  }
  return Promise.resolve()
}

async function pack(metadata, directory, outFile, version, packageCompressionLevel) {
  const archive = archiver('zip', {zlib: {level: packageCompressionLevel || 9}})
  // const archiveOut = createWriteStream('/Users/develar/test.zip')
  const archiveOut = createWriteStream(outFile)
  const archivePromise = new Promise(function (resolve, reject) {
    archive.on('error', reject)
    archiveOut.on('close', resolve)
  })
  archive.pipe(archiveOut)

  const author = metadata.authors || metadata.owners
  const copyright = metadata.copyright || `Copyright © ${new Date().getFullYear()} ${author}`
  const nuspecContent = `<?xml version="1.0"?>
<package xmlns="http://schemas.microsoft.com/packaging/2011/08/nuspec.xsd">
  <metadata>
    <id>${metadata.name}</id>
    <version>${version}</version>
    <title>${metadata.title}</title>
    <authors>${author}</authors>
    <owners>${metadata.owners || metadata.authors}</owners>
    <iconUrl>${metadata.iconUrl}</iconUrl>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
    <description>${metadata.description}</description>
    <copyright>${copyright}</copyright>${metadata.extraMetadataSpecs || ''}
  </metadata>
</package>`;
  log(`Created NuSpec file:\n${nuspecContent}`)
  archive.append(nuspecContent.replace(/\n/, '\r\n'), {name: `${encodeURI(metadata.name).replace(/%5B/g, '[').replace(/%5D/g, ']')}.nuspec`})

  archive.append(`<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="/${metadata.name}.nuspec" Id="Re0" />
  <Relationship Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="/package/services/metadata/core-properties/1.psmdcp" Id="Re1" />
</Relationships>`.replace(/\n/, '\r\n'), {name: '.rels', prefix: '_rels'})

  archive.append(`<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="nuspec" ContentType="application/octet" />
  <Default Extension="pak" ContentType="application/octet" />
  <Default Extension="asar" ContentType="application/octet" />
  <Default Extension="bin" ContentType="application/octet" />
  <Default Extension="dll" ContentType="application/octet" />
  <Default Extension="exe" ContentType="application/octet" />
  <Default Extension="dat" ContentType="application/octet" />
  <Default Extension="psmdcp" ContentType="application/vnd.openxmlformats-package.core-properties+xml" />
  <Override PartName="/lib/net45/LICENSE" ContentType="application/octet" />
  <Default Extension="diff" ContentType="application/octet" />
  <Default Extension="bsdiff" ContentType="application/octet" />
  <Default Extension="shasum" ContentType="text/plain" />
</Types>`.replace(/\n/, '\r\n'), {name: '[Content_Types].xml'})

  archive.append(`<?xml version="1.0" encoding="utf-8"?>
<coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                xmlns="http://schemas.openxmlformats.org/package/2006/metadata/core-properties">
  <dc:creator>${author}</dc:creator>
  <dc:description>${metadata.description}</dc:description>
  <dc:identifier>${metadata.name}</dc:identifier>
  <version>${version}</version>
  <keywords/>
  <dc:title>${metadata.title}</dc:title>
  <lastModifiedBy>NuGet, Version=2.8.50926.602, Culture=neutral, PublicKeyToken=null;Microsoft Windows NT 6.2.9200.0;.NET Framework 4</lastModifiedBy>
</coreProperties>`.replace(/\n/, '\r\n'), {name: '1.psmdcp', prefix: 'package/services/metadata/core-properties'})

  encodedZip(archive, directory, 'lib/net45')
  await archivePromise
}

function releasify(nupkgPath, outputDirectory) {
  const args = [
    '--releasify', nupkgPath,
    '--releaseDir', outputDirectory
  ]
  return spawn(process.platform === 'win32' ? vendor('Update.com') : 'mono', prepareArgs(args, vendor('Update-Mono.exe')))
}

function msi(nupkgPath, setupPath) {
  const args = [
    '--createMsi', nupkgPath,
    '--bootstrapperExe', setupPath
  ]
  return spawn(process.platform === 'win32' ? vendor('Update.com') : 'mono', prepareArgs(args, vendor('Update-Mono.exe')))
}

function writeZipToSetup(setupExe, zipFile) {
  const exePath = vendor('WriteZipToSetup.exe')
  return spawn(process.platform === 'win32' ? exePath : 'wine', prepareArgs([setupExe, zipFile], exePath))
}

function prepareArgs(args, exePath) {
  if (process.platform !== 'win32') {
    args.unshift(exePath)
  }
  return args
}

function vendor(executable) {
  return path.join(__dirname, '..', 'vendor', executable)
}

function encodedZip(archive, dir, prefix) {
  archiverUtil.walkdir(dir, function (error, files) {
    if (error) {
      archive.emit('error', error)
      return
    }

    for (let file of files) {
      if (file.stats.isDirectory()) {
        continue
      }

      // GBK file name encoding (or Non-English file name) caused a problem
      const entryData = {
        name: encodeURI(file.relative.replace(/\\/g, '/')).replace(/%5B/g, '[').replace(/%5D/g, ']'),
        prefix: prefix,
        stats: file.stats,
      }
      archive._append(file.path, entryData)
    }

    archive.finalize()
  })
}