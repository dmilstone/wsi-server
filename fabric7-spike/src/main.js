import OpenSeadragon from 'openseadragon';
import { Rect, Text } from 'fabric';
import { initOSDFabricOverlay } from 'openseadragon-fabric-overlay';
import { clone, mergeById } from './model.js';

const state = { imageId: null, records: new Map(), objects: new Map(), sequence: 0 };
const counters = Object.fromEntries([
  'object:moving', 'object:scaling', 'object:modified', 'selection:created',
  'selection:updated', 'selection:cleared', 'object:added', 'object:removed', 'logical:commit'
].map(name => [name, 0]));
const $ = id => document.getElementById(id);
const viewer = OpenSeadragon({ id: 'fabric7-viewer', prefixUrl: '/fabric7-spike/images/', showNavigator: true });
// Version 2 accepts the Viewer instance directly and returns the overlay.
const overlay = initOSDFabricOverlay(viewer, {
  fabricCanvasOptions: { selection: true }
}, 'fabric7-spike-overlay');
const canvas = overlay.fabricCanvas();

function count(name) {
  counters[name] += 1;
  $(`count-${name.replace(':', '-')}`).textContent = counters[name];
}
function recordFor(object) { return state.records.get(object.annotationId); }
function imageRectToOverlay(annotation) {
  const geometry = annotation.geometry;
  const a = viewer.viewport.imageToViewportCoordinates(geometry.x, geometry.y);
  const b = viewer.viewport.imageToViewportCoordinates(geometry.x + geometry.width, geometry.y + geometry.height);
  return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y, scaleX: 1, scaleY: 1 };
}
function overlayRectToImage(object) {
  const a = viewer.viewport.viewportToImageCoordinates(object.left, object.top);
  const b = viewer.viewport.viewportToImageCoordinates(object.left + object.width * object.scaleX, object.top + object.height * object.scaleY);
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}
function updateLabel(object) {
  const record = recordFor(object);
  const label = object.annotationLabel;
  if (!label || !record) return;
  label.set({ left: object.left, top: object.top - 0.025, text: record.name || '' });
  label.visible = $('show-names').checked && Boolean(record.name);
}
function commit(object) {
  const record = recordFor(object);
  if (!record) return;
  record.geometry = overlayRectToImage(object);
  record.updatedAt = new Date().toISOString();
  object.set(imageRectToOverlay(record));
  count('logical:commit');
}
['object:moving', 'object:scaling'].forEach(event => canvas.on(event, ({ target }) => {
  count(event); updateLabel(target); canvas.requestRenderAll();
}));
canvas.on('object:modified', ({ target }) => { count('object:modified'); commit(target); updateLabel(target); });
['selection:created', 'selection:updated', 'selection:cleared', 'object:added', 'object:removed']
  .forEach(event => canvas.on(event, () => count(event)));

function makeObjects(record) {
  const rect = new Rect({ ...imageRectToOverlay(record), fill: 'rgba(0,170,255,.12)', stroke: '#00aaff', strokeWidth: 0.003,
    selectable: !record.locking?.locked, evented: !record.locking?.locked, visible: record.visibility?.geometry !== false });
  rect.annotationId = record.id;
  const label = new Text(record.name || '', { left: rect.left, top: rect.top - 0.025, fontSize: 0.02,
    fill: '#fff', backgroundColor: 'rgba(0,0,0,.72)', selectable: false, evented: false,
    visible: record.visibility?.name !== false && Boolean(record.name) });
  rect.annotationLabel = label;
  state.objects.set(record.id, rect);
  canvas.add(rect, label);
  return rect;
}
function clearCanvas() {
  canvas.discardActiveObject();
  [...canvas.getObjects()].forEach(object => canvas.remove(object));
  state.objects.clear();
}
function showImageRecords() {
  clearCanvas();
  [...state.records.values()].filter(record => record.imageId === state.imageId).forEach(makeObjects);
  canvas.requestRenderAll();
}
function visibleImageBounds() {
  const bounds = viewer.viewport.getBounds(true);
  const a = viewer.viewport.viewportToImageCoordinates(bounds.getTopLeft());
  const b = viewer.viewport.viewportToImageCoordinates(bounds.getBottomRight());
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}
function addRectangle() {
  if (!state.imageId) return;
  const bounds = visibleImageBounds();
  const now = new Date().toISOString();
  const record = { id: crypto.randomUUID(), imageId: state.imageId, name: null, bodies: [], createdAt: now, updatedAt: now,
    visibility: { geometry: true, name: true }, locking: { locked: false }, metadata: {},
    geometry: { x: bounds.x + bounds.width * .375, y: bounds.y + bounds.height * .375, width: bounds.width * .25, height: bounds.height * .25 } };
  state.records.set(record.id, record);
  makeObjects(record);
  canvas.discardActiveObject();
  canvas.requestRenderAll();
}
function selectedRect() { const active = canvas.getActiveObject(); return active?.annotationId ? active : null; }
function refreshVisibility() {
  for (const rect of state.objects.values()) {
    const record = recordFor(rect);
    rect.visible = $('show-geometry').checked && record.visibility?.geometry !== false;
    updateLabel(rect);
  }
  canvas.requestRenderAll();
}

$('add-rectangle').addEventListener('click', addRectangle);
$('delete-rectangle').addEventListener('click', () => {
  const rect = selectedRect(); if (!rect) return;
  state.records.delete(rect.annotationId); canvas.remove(rect.annotationLabel, rect); state.objects.delete(rect.annotationId);
});
$('annotation-name').addEventListener('change', event => {
  const rect = selectedRect(); if (!rect) return;
  const record = recordFor(rect); record.name = event.target.value || null; record.updatedAt = new Date().toISOString(); updateLabel(rect); canvas.requestRenderAll();
});
canvas.on('selection:created', ({ selected }) => { $('annotation-name').value = recordFor(selected[0])?.name || ''; });
canvas.on('selection:cleared', () => { $('annotation-name').value = ''; });
$('show-geometry').addEventListener('change', refreshVisibility);
$('show-names').addEventListener('change', refreshVisibility);
$('export-json').addEventListener('click', () => { $('json-data').value = JSON.stringify([...state.records.values()], null, 2); });
$('import-json').addEventListener('click', () => {
  const merged = mergeById([...state.records.values()], JSON.parse($('json-data').value));
  state.records = new Map(merged.map(record => [record.id, clone(record)])); showImageRecords();
});

async function loadImages() {
  const response = await fetch('/api/images', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Image list failed (${response.status})`);
  const payload = await response.json();
  const images = payload.images || payload;
  images.forEach(image => {
    const option = document.createElement('option'); option.value = image.id; option.textContent = image.name || image.id; $('image-select').append(option);
  });
  if (images[0]) await openImage(images[0].id);
}
async function openImage(id) {
  clearCanvas(); state.imageId = id;
  const [metadata, display] = await Promise.all([
    fetch(`/api/images/${encodeURIComponent(id)}`).then(response => response.json()),
    fetch(`/api/images/${encodeURIComponent(id)}/display`).then(response => response.json())
  ]);
  const tileSource = { width: metadata.width, height: metadata.height, tileSize: metadata.tileSize, tileOverlap: 0,
    minLevel: 0, maxLevel: metadata.resolutionCount - 1,
    getTileUrl(level, x, y) { return `/tile/${encodeURIComponent(id)}/composite/${level}/${x}/${y}.png?revision=${display.revision}`; } };
  await new Promise((resolve, reject) => { viewer.addOnceHandler('open', resolve); viewer.addOnceHandler('open-failed', reject); viewer.open(tileSource); });
  showImageRecords();
}
$('image-select').addEventListener('change', event => openImage(event.target.value));
loadImages().catch(error => { $('status').textContent = error.message; });
