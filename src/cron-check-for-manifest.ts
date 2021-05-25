#!/usr/bin/env node

import fetch from 'cross-fetch';
import { DestinyLoreDefinition, getDestinyManifest } from 'bungie-api-ts/destiny2';
import { generateHttpClient } from '@d2api/manifest';
import latest from '../latest.json';
import fse from 'fs-extra';
import * as nodepub from 'nodepub';

const { writeFileSync } = fse;
const httpClient = generateHttpClient(fetch, process.env.API_KEY);

const skipCheck = process.env.SKIP_CHECK === 'true' ? true : false;

const generateEpubs = async function (
  contentPaths: {
    [key: string]: {
      [key: string]: string;
    };
  },
  lang: string
) {
  const lorePath = contentPaths[lang].DestinyLoreDefinition;

  const lore: { [hash: number]: DestinyLoreDefinition } = await fetch(
    `https://bungie.net${lorePath}`
  )
    .then((res) => res.json())
    .then((body: { [hash: number]: DestinyLoreDefinition }) => body);

  const date = new Date();

  const metadata = {
    id: '0',
    cover: './assets/cover.jpg',
    genre: 'Science Fiction',
    title: 'Grimoire', // *Required, title of the book.
    author: 'Bungie', // *Required, name of the author.
    language: lang,
    contents: 'Table of Contents',
    source: 'https://www.bungie.net',
    published: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
    description: 'The Destiny 2 Grimoire',
    images: [],
  };

  const epub = nodepub.document(metadata);

  const loreKeys = Object.keys(lore);
  const loreArrayWithDupes = [];
  const uniqueNames = new Set();
  const loreArray = [];

  for (const key of loreKeys) {
    loreArrayWithDupes.push(lore[Number(key)]);
  }

  loreArrayWithDupes.sort(
    (a: DestinyLoreDefinition, b: DestinyLoreDefinition) => a.index - b.index
  );

  for (const loreItem of loreArrayWithDupes) {
    if (uniqueNames.has(loreItem.displayProperties.name)) {
      continue;
    }
    uniqueNames.add(loreItem.displayProperties.name);
    loreArray.push(loreItem);
  }

  for (const loreItem of loreArray) {
    const title = loreItem.displayProperties.name;
    const data =
      loreItem.displayProperties.description.length &&
      loreItem.displayProperties.description !== 'Keep it secret.  Keep it safe.'
        ? loreItem.displayProperties.description
            .split('\n\n')
            .map((i) => `<p>${i}</p>`)
            .join('')
            .split('\n')
            .join('<br>')
        : '';

    if (title && data) {
      epub.addSection(title, `<h1>${title}</h1>${data}`);
    } // else console.log(loreItem);
  }

  await epub.writeEPUB('./epub', `grimoire-${lang}`);
};

// do the thing
(async () => {
  const manifestMetadata = await getDestinyManifest(httpClient);

  const current = manifestMetadata.Response.version;
  const newREADME = `# d2-manifest-bot\ngithub action for checking for new d2 manifest\n\n# Current Manifest: ${current}`;

  if (!skipCheck) {
    console.log(`Latest:  ${latest}`);
    console.log(`Current: ${current}`);
    if (latest === current) {
      // nothing changed. no updates needed.
      return;
    }
    // if you are here, there's a new manifest
    console.log('New manifest detected');
  }

  const contentPaths = manifestMetadata.Response.jsonWorldComponentContentPaths;
  await Promise.all(Object.keys(contentPaths).map((lang) => generateEpubs(contentPaths, lang)));

  writeFileSync('latest.json', `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  writeFileSync('README.md', newREADME, 'utf8');

  // if (!/^[.\w-]+$/.test(versionNumber)) { I AM NOT REALLY SURE THIS NEEDS DOING. }
})().catch((e) => {
  console.log(e);
  process.exit(1);
});
