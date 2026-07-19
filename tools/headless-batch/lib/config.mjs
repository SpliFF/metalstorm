import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function loadJson(filePath) {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text);
}

export async function writeJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value, null, 2));
}
