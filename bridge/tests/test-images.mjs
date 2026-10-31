/**
 * Image routing and file handling.
 *
 * The point of these checks: routing a normal turn into the image model is a
 * silent catastrophe (the user gets a picture instead of an answer), so the
 * intent matcher is tested in both languages, including its false friends —
 * "что на картинке" must never be routed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-images-'));
process.env.AG_IMAGE_DIR = dir;

// Imported after the env var exists: lib/config.js reads it at module load.
const { answerText, isImageModel, routeFor, saveImage, wantsImage } = await import('../lib/images.js');

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`PASS  ${name}` + (detail ? `  (${detail})` : ''));
  } else {
    failed += 1;
    console.log(`FAIL  ${name}` + (detail ? `  (${detail})` : ''));
  }
}

const asks = [
  ['нарисуй кота в космосе', true],
  ['сгенерируй изображение заката над морем', true],
  ['сделай фото красивого заката', true],
  ['сделай арт в стиле киберпанк', true],
  ['перерисуй это в акварель', true],
  ['draw a red apple on a wooden table', true],
  ['generate an image of a lighthouse at dusk', true],
  ['paint a fox in watercolor', true],
  ['что на этой картинке?', false],
  ['опиши фото, которое я приложил', false],
  ['проанализируй изображение и скажи что там', false],
  ['напиши функцию на js для сортировки', false],
  ['почему море солёное', false],
  ['создай файл .env и запиши туда ключ', false],
  ['make a tool that lists files', false],
  ['артерия и вена в чём разница', false],
  ['', false]
];

for (const [text, expected] of asks) {
  check(`intent: ${JSON.stringify(text).slice(0, 46)}`, wantsImage(text) === expected, `expected ${expected}`);
}

const user = (text) => ({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: text }] });

check('route: a drawing sentence goes to the image model', routeFor(user('нарисуй кота')) === 'auto');
check('route: a normal question stays on the text model', routeFor(user('напиши сортировку')) === null);
check(
  'route: naming the image model skips the intent check',
  routeFor({ model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: 'привет' }] }) === 'direct'
);
check('model: -image suffix recognized', isImageModel('gemini-3.1-flash-image'));
check('model: text model not recognized', !isImageModel('gemini-3.8-flash'));
check(
  'route: a question about an attached picture is not a drawing request',
  routeFor({
    model: 'gemini-3.8-flash',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'опиши, что на этой картинке' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
        ]
      }
    ]
  }) === null
);

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const file = saveImage('image/png', png);
check('save: file exists', fs.existsSync(file), file);
check('save: lands in AG_IMAGE_DIR', path.dirname(file) === dir);
check('save: png extension', file.endsWith('.png'));
check('save: bytes round-trip', fs.readFileSync(file).equals(Buffer.from(png, 'base64')));

const jpg = saveImage('image/jpeg', png);
check('save: jpeg extension', jpg.endsWith('.jpg'));

const text = answerText([file], 'With pleasure.');
check('answer: prose kept', text.startsWith('With pleasure.'));
check('answer: markdown image with forward slashes', text.includes(file.replace(/\\/g, '/')) && text.includes('![generated image]('));
check('answer: silent model still gets a sentence', answerText([file], '').startsWith('Generated an image.'));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall image checks passed');
process.exit(failed ? 1 : 0);