export const clone = value => JSON.parse(JSON.stringify(value));

export function mergeById(current, imported) {
  const byId = new Map(current.map(item => [item.id, clone(item)]));
  imported.forEach(item => {
    if (!item || typeof item.id !== 'string') throw new Error('Every annotation needs a string ID');
    byId.set(item.id, clone(item));
  });
  return [...byId.values()];
}

export function imageRectToFabric(annotation) {
  const { x, y, width, height } = annotation.geometry;
  return { left: x, top: y, width, height, scaleX: 1, scaleY: 1 };
}

export function fabricRectToImage(object) {
  return {
    x: object.left,
    y: object.top,
    width: object.width * object.scaleX,
    height: object.height * object.scaleY
  };
}
