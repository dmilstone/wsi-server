import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const bundle = fileURLToPath(new URL('../../src/main/resources/static/fabric7-spike/spike.bundle.js', import.meta.url));

try {
  const details = await stat(bundle);
  if (!details.isFile() || details.size === 0) throw new Error('generated file is empty');
} catch (error) {
  console.error(`Fabric overlay spike bundle verification failed: ${error.message}. Run npm ci and npm run build in fabric7-spike/.`);
  process.exitCode = 1;
}
