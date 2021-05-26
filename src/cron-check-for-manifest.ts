#!/usr/bin/env node

import fetch from 'cross-fetch';
import {
  DestinyDefinition,
  DestinyLoreDefinition,
  DestinyPresentationNodeDefinition,
  DestinyRecordDefinition,
  getDestinyManifest,
} from 'bungie-api-ts/destiny2';
import { generateHttpClient } from '@d2api/manifest';
import latest from '../latest.json';
import fse from 'fs-extra';
import * as nodepub from 'nodepub';
import { pipeline } from 'stream';
import { promisify } from 'util';

const { writeFileSync } = fse;
const httpClient = generateHttpClient(fetch, process.env.API_KEY);

const skipCheck = process.env.SKIP_CHECK === 'true' ? true : false;

const fetchDefinition = async function (
  contentPaths: {
    [key: string]: {
      [key: string]: string;
    };
  },
  lang: string,
  definition: string
) {
  const path = contentPaths[lang][definition];
  const definitions = await fetch(`https://bungie.net${path}`)
    .then((res) => res.json())
    .then((body: { [hash: number]: DestinyDefinition }) => body);
  return definitions;
};

const downloadFile = async (url: string, path: string) => {
  const streamPipeline = promisify(pipeline);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`unexpected response ${response.statusText}`);
  await streamPipeline(<any>response.body, fse.createWriteStream(path));
};

const prepImages = async function (
  metadata: NodepubMetadata,
  definitionTreeNode: DefinitionTreeNode
) {
  if (
    definitionTreeNode.type === 'DestinyPresentationNodeDefinition' &&
    definitionTreeNode.definition.displayProperties.hasIcon
  ) {
    const splitPath = definitionTreeNode.definition.displayProperties.icon.split('/');
    const iconPath = splitPath[splitPath.length - 1];
    await downloadFile(
      `https://bungie.net${definitionTreeNode.definition.displayProperties.icon}`,
      `./assets/icons/${iconPath}`
    );
    metadata.images.push(`./assets/icons/${iconPath}`);
  }
  for (const child of definitionTreeNode.childrenSorted) {
    await prepImages(metadata, child);
  }
};

const addSection = async function (epub: any, definitionTreeNode: DefinitionTreeNode) {
  let iconPath = '';
  if (
    definitionTreeNode.type === 'DestinyPresentationNodeDefinition' &&
    definitionTreeNode.definition.displayProperties.hasIcon
  ) {
    const splitPath = definitionTreeNode.definition.displayProperties.icon.split('/');
    iconPath = splitPath[splitPath.length - 1];
  }
  const title = definitionTreeNode.definition.displayProperties.name;

  const data =
    definitionTreeNode.type === 'DestinyLoreDefinition'
      ? `<h1>${title}</h1>${definitionTreeNode.definition.displayProperties.description
          .split('\n\n')
          .map((i) => `<p>${i}</p>`)
          .join('')
          .split('\n')
          .join('<br>')}`
      : `<img class="presentationNodeIcon" src="${`../images/${iconPath}`}" />
      <h1 class="presentationNodeTitle">${title}</h1>`;

  if (title && data) {
    epub.addSection(title, data);
  } // else console.log(loreItem);

  for (const child of definitionTreeNode.childrenSorted) {
    await addSection(epub, child);
  }
};

const appendContents = function (
  contents: string,
  definitionTreeNode: DefinitionTreeNode,
  links: NodepubContentsLink[]
) {
  const link = links.filter(
    (l) => l.title === definitionTreeNode.definition.displayProperties.name
  )[0];
  if (definitionTreeNode.type === 'DestinyLoreDefinition') {
    return `${contents}<li><a href="${link.link}">${link.title}</a></li>`;
  } else {
    const listStart =
      definitionTreeNode.childrenSorted[0].type === 'DestinyLoreDefinition'
        ? `<ol type="i">`
        : `<ul>`;
    const listEnd =
      definitionTreeNode.childrenSorted[0].type === 'DestinyLoreDefinition' ? `</ol>` : `</ul>`;
    contents = `${contents}<li><a href="${link.link}">${link.title}</a></li>`;
    contents = `${contents}${listStart}`;
    for (const child of definitionTreeNode.childrenSorted) {
      contents = appendContents(contents, child, links);
    }
    return `${contents}${listEnd}`;
  }
};

let definitionTreeRootNode: DefinitionTreeNode | undefined = undefined;

const makeContentsPage = function (links: NodepubContentsLink[]) {
  let contents = '<h1>Chapters</h1><ul>';
  if (definitionTreeRootNode) {
    contents = appendContents(contents, definitionTreeRootNode, links);
  }
  contents = `${contents}</ul>`;
  return contents;
};

const generateEpub = async function (
  contentPaths: {
    [key: string]: {
      [key: string]: string;
    };
  },
  lang: string
) {
  const lore = (await fetchDefinition(contentPaths, lang, 'DestinyLoreDefinition')) as {
    [hash: number]: DestinyLoreDefinition;
  };
  const presentationNodes = (await fetchDefinition(
    contentPaths,
    lang,
    'DestinyPresentationNodeDefinition'
  )) as { [hash: number]: DestinyPresentationNodeDefinition };
  const records = (await fetchDefinition(contentPaths, lang, 'DestinyRecordDefinition')) as {
    [hash: number]: DestinyRecordDefinition;
  };

  for (const key of Object.keys(presentationNodes)) {
    const node = presentationNodes[Number(key)];
    if (
      node.parentNodeHashes.length ||
      (!node.children.presentationNodes.length &&
        !node.children.collectibles.length &&
        !node.children.records.length)
    ) {
      continue;
    }
    // console.log(node.displayProperties.name, node.displayProperties.description);
  }

  const definitionTreeNodeArray: DefinitionTreeNode[] = [];

  for (const key of Object.keys(records)) {
    const node = records[Number(key)];
    if (!node.loreHash || !node.parentNodeHashes.length) {
      continue;
    }
    const filtered = definitionTreeNodeArray.filter((n) => n.key === node.loreHash);
    if (!filtered.length) {
      const loreNode = lore[node.loreHash];
      let currentDefinitionTreeNode: DefinitionTreeNode = {
        key: node.loreHash,
        type: 'DestinyLoreDefinition',
        definition: loreNode,
        children: new Set(),
        childrenSorted: [],
      };
      definitionTreeNodeArray.push(currentDefinitionTreeNode);
      let currentNode: DestinyRecordDefinition | DestinyPresentationNodeDefinition = node;
      while (currentNode.parentNodeHashes.length) {
        const parentNode: DestinyPresentationNodeDefinition =
          presentationNodes[Number(currentNode.parentNodeHashes[0])];
        if (!definitionTreeNodeArray.filter((n) => n.key === parentNode.hash).length) {
          definitionTreeNodeArray.push({
            key: parentNode.hash,
            type: 'DestinyPresentationNodeDefinition',
            definition: parentNode,
            children: new Set(),
            childrenSorted: [],
          });
        }
        const parentDefinitionTreeNode = definitionTreeNodeArray.filter(
          (n) => n.key === parentNode.hash
        )[0];
        parentDefinitionTreeNode.children.add(currentDefinitionTreeNode);
        parentDefinitionTreeNode.childrenSorted = Array.from(
          parentDefinitionTreeNode.children
        ).sort((a, b) => a.definition.index - b.definition.index);
        currentNode = parentNode;
        currentDefinitionTreeNode = parentDefinitionTreeNode;
      }
      definitionTreeRootNode = currentDefinitionTreeNode;
    }
  }

  while (definitionTreeRootNode && definitionTreeRootNode.childrenSorted.length < 2) {
    definitionTreeRootNode = definitionTreeRootNode.childrenSorted[0];
  }

  const date = new Date();

  const metadata: NodepubMetadata = {
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

  if (definitionTreeRootNode) {
    await prepImages(metadata, definitionTreeRootNode);
  }

  const epub = nodepub.document(metadata, makeContentsPage);

  epub.addCSS(
    `.presentationNodeIcon { text-align: center; margin-top: 20%; margin-left: 40%; width: 20%; } .presentationNodeTitle { text-align: center; }`
  );

  if (definitionTreeRootNode) {
    await addSection(epub, definitionTreeRootNode);
  }

  // const loreKeys = Object.keys(lore);
  // const loreArrayWithDupes = [];
  // const uniqueNames = new Set();
  // const loreArray = [];

  // for (const key of loreKeys) {
  //   loreArrayWithDupes.push(lore[Number(key)]);
  // }

  // loreArrayWithDupes.sort(
  //   (a: DestinyLoreDefinition, b: DestinyLoreDefinition) => a.index - b.index
  // );

  // for (const loreItem of loreArrayWithDupes) {
  //   if (uniqueNames.has(loreItem.displayProperties.name)) {
  //     continue;
  //   }
  //   uniqueNames.add(loreItem.displayProperties.name);
  //   loreArray.push(loreItem);
  // }

  // for (const loreItem of loreArray) {
  //   const title = loreItem.displayProperties.name;
  //   const data =
  //     loreItem.displayProperties.description.length &&
  //     loreItem.displayProperties.description !== 'Keep it secret.  Keep it safe.'
  //       ? loreItem.displayProperties.description
  //           .split('\n\n')
  //           .map((i) => `<p>${i}</p>`)
  //           .join('')
  //           .split('\n')
  //           .join('<br>')
  //       : '';

  //   if (title && data) {
  //     epub.addSection(title, `<h1>${title}</h1>${data}`);
  //   } // else console.log(loreItem);
  // }

  await epub.writeEPUB('./epub', `grimoire-${lang}`);
};

// do the thing
(async () => {
  const manifestMetadata = await getDestinyManifest(httpClient);

  const current = manifestMetadata.Response.version;
  const newREADME = `# d2-grimoire-epub\ngithub action for generating grimoire epub files when the d2 manifest is updated\n\n# Current Manifest: ${current}`;

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

  fse.emptyDirSync('./assets/icons');
  fse.emptyDirSync('./epub');

  const contentPaths = manifestMetadata.Response.jsonWorldComponentContentPaths;
  for (const lang of Object.keys(contentPaths)) {
    await generateEpub(contentPaths, lang);
  }
  // await Promise.all(Object.keys(contentPaths).map((lang) => generateEpub(contentPaths, lang)));

  writeFileSync('latest.json', `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  writeFileSync('README.md', newREADME, 'utf8');

  // if (!/^[.\w-]+$/.test(versionNumber)) { I AM NOT REALLY SURE THIS NEEDS DOING. }
})().catch((e) => {
  console.log(e);
  process.exit(1);
});

interface DefinitionTreeNode {
  key: number;
  type: 'DestinyLoreDefinition' | 'DestinyPresentationNodeDefinition';
  definition: DestinyLoreDefinition | DestinyPresentationNodeDefinition;
  children: Set<DefinitionTreeNode>;
  childrenSorted: DefinitionTreeNode[];
}

interface NodepubMetadata {
  id: string;
  cover: string;
  title: string;
  series?: string;
  sequence?: number;
  author: string;
  fileAs?: string;
  genre: string;
  tags?: string;
  copyright?: string;
  publisher?: string;
  published: string;
  language: string;
  description?: string;
  contents: string;
  source: string;
  images: string[];
}

interface NodepubContentsLink {
  title: string;
  link: string;
  itemType: 'front' | 'contents' | 'main';
}
