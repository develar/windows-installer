import { spawn, exec } from './spawn-promise'
import path from 'path';
import { Promise } from 'bluebird';
import { sign as signCallback } from 'signcode-tf'
import archiver from 'archiver'
import { emptyDir, copy, remove, createWriteStream, unlink } from 'fs-extra-p'
import archiverUtil from 'archiver-utils'
import { tmpdir } from 'os'

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

function syncReleases(outputDirectory, options) {
  const args = prepareArgs(['-u', options.remoteReleases, '-r', outputDirectory], vendor('SyncReleases.exe'))
  if (options.remoteToken) {
    args.push('-t', options.remoteToken)
  }
  return spawn(process.platform === 'win32' ? vendor('SyncReleases.exe') : 'mono', args)
}

async function copyUpdateExe(desitination, options, rcEditOptions, baseSignOptions) {
  await copy(vendor('Update.exe'), desitination)
  if (options.setupIcon && (options.skipUpdateIcon !== true)) {
    await rcedit(desitination, rcEditOptions)
  }
  await signFile(desitination, baseSignOptions)
}

export async function createWindowsInstaller(options) {
  const stageDir = path.join(tmpdir(), getTempName('squirrel-windows-builder'))
  await emptyDir(stageDir)
  try {
    await build(options, stageDir)
  }
  finally {
    try {
      await remove(stageDir)
    }
    catch (e) {
      // ignore
    }
  }
}

async function build(options, stageDir) {
  const rcEditOptions = Object.assign({}, options.rcedit, {
    icon: options.setupIcon
  })
  const rcVersionString = rcEditOptions['version-string']
  if (rcVersionString != null && rcVersionString.LegalCopyright != null) {
    // rcedit cannot set © symbol (or windows bug?), replace to safe
    rcVersionString.LegalCopyright = rcVersionString.LegalCopyright.replace('©', '(C)');
  }

  const metadata = options
  const baseSignOptions = options.certificateFile && options.certificatePassword ? Object.assign({
    cert: options.certificateFile,
    password: options.certificatePassword,
    name: metadata.title,
    overwrite: true
  }, options.sign) : null

  const appUpdate = path.join(stageDir, 'Update.exe')
  const outputDirectory = path.resolve(options.outputDirectory || 'installer')
  const promises = [
    copyUpdateExe(appUpdate, options, rcEditOptions, baseSignOptions),
    emptyDir(outputDirectory)
  ]
  if (options.remoteReleases) {
    promises.push(syncReleases(outputDirectory, options));
  }
  await Promise.all(promises)

  const embeddedArchiveFile = path.join(stageDir, 'setup.zip')
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
    pack(metadata, options.appDirectory, appUpdate, nupkgPath, version, options.packageCompressionLevel),
    copy(vendor('Setup.exe'), setupPath),
  ])

  embeddedArchive.file(nupkgPath, {name: packageName})

  const releaseEntry = await releasify(nupkgPath, outputDirectory, packageName)

  embeddedArchive.append(releaseEntry, {name: 'RELEASES'})
  embeddedArchive.finalize()
  await embeddedArchivePromise

  await writeZipToSetup(setupPath, embeddedArchiveFile)
  await rcedit(setupPath, rcEditOptions)

  await signFile(setupPath, baseSignOptions)
  if (options.msi && process.platform === 'win32') {
    const outFile = options.msiExe || `${metadata.productName}Setup.msi`;
    await msi(nupkgPath, setupPath, outputDirectory, outFile)
    await signFile(path.join(outputDirectory, outFile), baseSignOptions)
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

async function pack(metadata, directory, updateFile, outFile, version, packageCompressionLevel) {
  const archive = archiver('zip', {zlib: {level: packageCompressionLevel == null ? 9 : packageCompressionLevel}})
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

  archive.file(updateFile, {name: 'Update.exe', prefix: 'lib/net45'})
  encodedZip(archive, directory, 'lib/net45')
  await archivePromise
}

async function releasify(nupkgPath, outputDirectory, packageName) {
  const args = [
    '--releasify', nupkgPath,
    '--releaseDir', outputDirectory
  ]
  const out = (await exec(process.platform === 'win32' ? vendor('Update.com') : 'mono', prepareArgs(args, vendor('Update-Mono.exe')))).trim()
  if (log.enabled) {
    log(out)
  }

  const lines = out.split('\n');
  for (let i = lines.length - 1; i > -1; i--) {
    const line = lines[i];
    if (line.indexOf(packageName) != -1) {
      return line.trim()
    }
  }

  throw new Error('Invalid output, cannot find last release entry')
}

async function msi(nupkgPath, setupPath, outputDirectory, outFile) {
  const args = [
    '--createMsi', nupkgPath,
    '--bootstrapperExe', setupPath
  ]
  await exec(process.platform === 'win32' ? vendor('Update.com') : 'mono', prepareArgs(args, vendor('Update-Mono.exe')))
  await exec(vendor('candle.exe'), ['-nologo', '-ext', 'WixNetFxExtension', '-out', 'Setup.wixobj', 'Setup.wxs'], {
    cwd: outputDirectory,
  })
  await exec(vendor('light.exe'), ['-ext', 'WixNetFxExtension', '-sval', '-out', outFile, 'Setup.wixobj'], {
    cwd: outputDirectory,
  })

  //noinspection SpellCheckingInspection
  await Promise.all([
    unlink(path.join(outputDirectory, 'Setup.wxs')),
    unlink(path.join(outputDirectory, 'Setup.wixobj')),
    unlink(path.join(outputDirectory, outFile.replace('.msi', '.wixpdb'))).catch(e => log(e.toString())),
  ])
}

function writeZipToSetup(setupExe, zipFile) {
  const exePath = vendor('WriteZipToSetup.exe')
  return exec(process.platform === 'win32' ? exePath : 'wine', prepareArgs([setupExe, zipFile], exePath))
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

let tmpDirCounter = 0
// add date to avoid use stale temp dir
const tempDirPrefix = `${process.pid.toString(36)}-${Date.now().toString(36)}`

export function getTempName(prefix) {
  return `${prefix == null ? '' : prefix + '-'}${tempDirPrefix}-${(tmpDirCounter++).toString(36)}`
}