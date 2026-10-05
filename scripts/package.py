#!/usr/bin/env python3
"""Build a private VSIX without vsce or network access.

Runtime files are explicitly allowlisted. Uses the VS Code VSIX manifest schema;
no signing, publishing, code execution or modifications outside --out-dir.
Rebuild TypeScript with `npm run build` before packaging edited sources.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VSIX_NS = 'http://schemas.microsoft.com/developer/vsx-schema/2011'
CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
FIXED_TIME = (2026, 10, 5, 0, 0, 0)


def manifest(package: dict) -> bytes:
    ET.register_namespace('', VSIX_NS)
    def el(parent, name, text=None, **attrs):
        node = ET.SubElement(parent, '{%s}%s' % (VSIX_NS, name), attrs)
        if text is not None:
            node.text = text
        return node
    root = ET.Element('{%s}PackageManifest' % VSIX_NS, {'Version': '2.0.0'})
    metadata = el(root, 'Metadata')
    el(metadata, 'Identity', Id=package['name'], Version=package['version'], Publisher=package['publisher'], Language='en-US')
    el(metadata, 'DisplayName', package['displayName'])
    desc = el(metadata, 'Description', package['description'])
    desc.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    el(metadata, 'Tags', ','.join(package.get('keywords', [])))
    el(metadata, 'Categories', ','.join(package.get('categories', ['Other'])))
    el(metadata, 'GalleryFlags')
    properties = el(metadata, 'Properties')
    pairs = {
        'Microsoft.VisualStudio.Code.Engine': package['engines']['vscode'],
        'Microsoft.VisualStudio.Code.ExtensionDependencies': '',
        'Microsoft.VisualStudio.Code.ExtensionPack': '',
        'Microsoft.VisualStudio.Code.ExtensionKind': ','.join(package['extensionKind']),
        'Microsoft.VisualStudio.Code.LocalizedLanguages': '',
        'Microsoft.VisualStudio.Code.EnabledApiProposals': '',
        'Microsoft.VisualStudio.Code.ExecutesCode': 'true',
        'Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown': 'true',
        'Microsoft.VisualStudio.Services.Content.Pricing': 'Free',
    }
    for key, value in pairs.items():
        el(properties, 'Property', Id=key, Value=value)
    el(metadata, 'License', 'extension/LICENSE.txt')
    installation = el(root, 'Installation')
    el(installation, 'InstallationTarget', Id='Microsoft.VisualStudio.Code')
    el(root, 'Dependencies')
    assets = el(root, 'Assets')
    for kind, name in (
        ('Microsoft.VisualStudio.Code.Manifest', 'package.json'),
        ('Microsoft.VisualStudio.Services.Content.Details', 'README.md'),
        ('Microsoft.VisualStudio.Services.Content.License', 'LICENSE.txt'),
        ('Microsoft.VisualStudio.Services.Content.Changelog', 'CHANGELOG.md'),
    ):
        el(assets, 'Asset', Type=kind, Path='extension/'+name, Addressable='true')
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def content_types() -> bytes:
    ET.register_namespace('', CT_NS)
    root = ET.Element('{%s}Types' % CT_NS)
    types = {
        'json': 'application/json', 'vsixmanifest': 'text/xml',
        'js': 'text/javascript', 'mjs': 'text/javascript',
        'css': 'text/css', 'svg': 'image/svg+xml', 'py': 'text/plain',
        'md': 'text/markdown', 'txt': 'text/plain',
    }
    for extension, mime in sorted(types.items()):
        ET.SubElement(root, '{%s}Default' % CT_NS, {'Extension': extension, 'ContentType': mime})
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def runtime_files() -> list[tuple[str, Path]]:
    names = ['package.json', 'README.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md',
             'docs/GUIA.md', 'docs/PRUEBAS.md', 'python/pty_host.py']
    for directory in ('dist', 'media', 'licenses'):
        names.extend(str(p.relative_to(ROOT)) for p in sorted((ROOT/directory).rglob('*')) if p.is_file())
    required = ['dist/extension.js', 'dist/bridge.js', 'dist/api.js',
                'media/main.js', 'media/vendor/xterm-fit.mjs', 'media/vendor/xterm.css']
    for name in names + required:
        if not (ROOT/name).is_file():
            raise FileNotFoundError('Missing runtime file: %s. Run npm run build first.' % name)
    result = [('extension/'+name, ROOT/name) for name in sorted(set(names))]
    result.append(('extension/LICENSE.txt', ROOT/'LICENSE'))
    for name, source in result:
        if source.is_symlink() or '..' in PurePosixPath(name).parts:
            raise ValueError('Symlinks and path traversal are not package inputs')
    return result


def validate(file: Path) -> dict:
    with zipfile.ZipFile(file) as archive:
        error = archive.testzip()
        if error:
            raise ValueError('Corrupt ZIP member: '+error)
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Duplicate ZIP members')
        for name in names:
            p = PurePosixPath(name)
            if p.is_absolute() or '..' in p.parts or '\\' in name:
                raise ValueError('Unsafe ZIP member: '+name)
            if 'node_modules' in p.parts or '__pycache__' in p.parts or name.endswith('.node'):
                raise ValueError('Unexpected development/native payload')
        package = json.loads(archive.read('extension/package.json'))
        root = ET.fromstring(archive.read('extension.vsixmanifest'))
        ET.fromstring(archive.read('[Content_Types].xml'))
        ident = root.find('{%s}Metadata/{%s}Identity' % (VSIX_NS, VSIX_NS))
        assert ident is not None
        assert ident.get('Id') == package['name']
        assert ident.get('Version') == package['version']
        assert ident.get('Publisher') == package['publisher']
        for asset in root.findall('{%s}Assets/{%s}Asset' % (VSIX_NS, VSIX_NS)):
            assert asset.get('Path') in names, asset.get('Path')
        for name in ['extension/'+(package['main'][2:] if package['main'].startswith('./') else package['main']),
                     'extension/python/pty_host.py', 'extension/media/main.js',
                     'extension/media/style.css', 'extension/media/vendor/xterm-fit.mjs',
                     'extension/media/vendor/xterm.css', 'extension/media/sideterm.svg']:
            assert name in names, name
        assert package['extensionKind'] == ['workspace']
        assert not package.get('dependencies')
        assert not package.get('enabledApiProposals')
        return {
            'filename': file.name, 'bytes': file.stat().st_size,
            'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
            'entries': len(names),
            'uncompressed_bytes': sum(i.file_size for i in archive.infolist()),
            'extension_id': package['publisher']+'.'+package['name'],
            'version': package['version'],
            'checks': ['ZIP CRC and path safety', 'VSIX XML and package identity',
                       'All declared assets present', 'All runtime entrypoints/resources present',
                       'No native addons, runtime npm dependencies or proposed VS Code APIs'],
            'actual_vscode_installation_tested': False,
        }


def build(out_dir: Path) -> dict:
    package = json.loads((ROOT/'package.json').read_text())
    files = runtime_files()
    payload = {'extension.vsixmanifest': manifest(package), '[Content_Types].xml': content_types()}
    for name, source in files:
        payload[name] = source.read_bytes()
    out_dir.mkdir(parents=True, exist_ok=True)
    file = out_dir/('%s-%s.vsix' % (package['name'], package['version']))
    temporary = file.with_suffix('.tmp')
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(payload.items()):
                info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data)
        report = validate(temporary)
        temporary.replace(file)
        report['filename'] = file.name
        (out_dir/'package-report.json').write_text(json.dumps(report, indent=2)+'\n')
        return report
    finally:
        if temporary.exists():
            temporary.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out-dir', type=Path, default=ROOT/'release')
    parser.add_argument('--verify', type=Path, help='Verify an existing VSIX instead of building')
    args = parser.parse_args()
    try:
        print(json.dumps(validate(args.verify) if args.verify else build(args.out_dir), indent=2))
    except (OSError, ValueError, AssertionError, KeyError, zipfile.BadZipFile) as exc:
        print('Packaging failed: %s' % exc, file=sys.stderr)
        sys.exit(1)
