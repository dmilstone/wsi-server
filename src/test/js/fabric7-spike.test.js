const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const source = read('fabric7-spike/src/main.js');
const html = read('src/main/resources/static/fabric7-spike.html');
const pkg = JSON.parse(read('fabric7-spike/package.json'));

test('spike declares the verified exact dependency versions', () => {
  assert.deepEqual(pkg.dependencies, { fabric: '7.2.0', openseadragon: '5.0.1', 'openseadragon-fabric-overlay': '2.0.0' });
  assert.equal(pkg.devDependencies.esbuild, '0.25.8');
  assert.doesNotMatch(read('fabric7-spike/package.json') + read('docs/FABRIC7-SPIKE-VALIDATION.md'), /1\.0\.4/);
  assert.equal(fs.existsSync(path.join(root, 'fabric7-spike/package-lock.json')), false, 'do not commit an unverified hand-authored lockfile');
});
test('uses the maintained version-2 initializer and no legacy/custom overlay', () => {
  assert.match(source, /from 'openseadragon-fabric-overlay'/);
  assert.match(source, /import \{ initOSDFabricOverlay \} from 'openseadragon-fabric-overlay'/);
  assert.match(source, /initOSDFabricOverlay\(viewer, \{\s*fabricCanvasOptions: \{ selection: true \}\s*\}, 'fabric7-spike-overlay'\)/s);
  assert.match(source, /const canvas = overlay\.fabricCanvas\(\)/);
  assert.doesNotMatch(source, /viewer\.fabricjsOverlay|initOSDFabricOverlay\(OpenSeadragon, fabric\)|Viewer\.prototype/);
  assert.doesNotMatch(source + html, /Annotorious|createAnnotation/);
  assert.equal(fs.existsSync(path.join(root, 'fabric7-spike/src/fabric-overlay.js')), false);
});
test('an absent generated bundle is reported by the isolated npm workflow', () => {
  assert.equal(fs.existsSync(path.join(root, 'src/main/resources/static/fabric7-spike/spike.bundle.js')), false);
  assert.match(html, /onerror=.*generated browser bundle is missing/);
  assert.equal(pkg.scripts['verify-bundle'], 'node scripts/verify-bundle.mjs');
  assert.match(read('fabric7-spike/scripts/verify-bundle.mjs'), /bundle verification failed/);
  assert.doesNotMatch(read('pom.xml'), /fabric7|Fabric overlay spike|maven-antrun-plugin/);
});
test('creation is button-driven at viewport center with no pointer drawing lifecycle', () => {
  assert.match(source, /visibleImageBounds\(\)/);
  assert.match(source, /bounds\.x \+ bounds\.width \* \.375/);
  assert.match(source, /new Rect/);
  assert.doesNotMatch(source, /mouse:(down|move|up)|pointer(down|move|up)|setPointerCapture|document\.addEventListener/);
});
test('spike cannot issue annotation write requests', () => {
  assert.doesNotMatch(source, /method:\s*['"](?:PUT|POST|PATCH|DELETE)['"]/i);
  assert.doesNotMatch(source, /AnnotationStore|annotation-store/);
});
test('movement and scaling position labels continuously and commit once on modified', () => {
  assert.match(source, /\['object:moving', 'object:scaling'\]/);
  assert.match(source, /count\(event\); updateLabel\(target\)/);
  assert.match(source, /canvas\.on\('object:modified'.*count\('object:modified'\); commit\(target\)/s);
  assert.equal((source.match(/count\('logical:commit'\)/g) || []).length, 1);
});
test('selection, deselection, deletion and independent visibility use native canvas APIs', () => {
  for (const token of ['selection:created', 'selection:cleared', 'discardActiveObject', 'remove\\(rect.annotationLabel, rect\\)', 'show-geometry', 'show-names']) assert.match(source, new RegExp(token));
});
test('JSON import deduplicates by ID, preserves records and isolates images', () => {
  const model = read('fabric7-spike/src/model.js');
  assert.match(model, /new Map\(current\.map\(item => \[item\.id, clone\(item\)\]\)\)/);
  assert.match(model, /byId\.set\(item\.id, clone\(item\)\)/);
  assert.match(source, /record\.imageId === state\.imageId/);
  assert.match(source, /clearCanvas\(\); state\.imageId = id/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/);
});
test('canonical adapter provides image-coordinate round trip', () => {
  const model = read('fabric7-spike/src/model.js');
  assert.match(model, /width: object\.width \* object\.scaleX/);
  assert.match(source, /imageToViewportCoordinates/);
  assert.match(source, /viewportToImageCoordinates/);
});
test('production and old spike assets are not referenced', () => {
  assert.doesNotMatch(html + source, /index\.html|annotorious-spike|annotation-adapter|annotation-store/);
});
