#!/usr/bin/env node

import fetch from 'cross-fetch';
import {
  DestinyCollectibleDefinition,
  DestinyDefinition,
  DestinyInventoryItemDefinition,
  DestinyLoreDefinition,
  DestinyPresentationNodeDefinition,
  DestinyRecordDefinition,
  getDestinyManifest,
} from 'bungie-api-ts/destiny2';
import { generateHttpClient } from '@d2api/manifest';
import latest from '../latest.json';
import fse from 'fs-extra';

const { writeFileSync } = fse;
const httpClient = generateHttpClient(fetch, process.env.API_KEY);

const skipCheck = process.env.SKIP_CHECK === 'true' ? true : false;
let justText = '';

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

const sortChildren = function (definitionTreeNode: DefinitionTreeNode) {
  definitionTreeNode.childrenSorted = Array.from(definitionTreeNode.children).sort((a, b) =>
    a.collectibleDefinition && b.collectibleDefinition
      ? a.collectibleDefinition?.index - b.collectibleDefinition?.index
      : <number>a.definition?.index - <number>b.definition?.index
  );
};

const addSection = async function (definitionTreeNode: DefinitionTreeNode) {
  const title = definitionTreeNode.definition?.displayProperties.name;

  if (title && definitionTreeNode.definition?.displayProperties.description) {
    justText += `${title}\n\n${definitionTreeNode.definition?.displayProperties.description}\n\n<|endoftext|>\n\n`;
  } // else console.log(loreItem);

  sortChildren(definitionTreeNode);
  for (const child of definitionTreeNode.childrenSorted) {
    await addSection(child);
  }
};

const reduceDepth = function (definitionTreeNode: DefinitionTreeNode) {
  if (
    definitionTreeNode.childrenSorted.length === 1 &&
    definitionTreeNode.childrenSorted[0].childrenSorted.length
  ) {
    definitionTreeNode.children = definitionTreeNode.childrenSorted[0].children;
    sortChildren(definitionTreeNode);
    reduceDepth(definitionTreeNode);
    return;
  }
  if (definitionTreeNode.type === 'DestinyPresentationNodeDefinition') {
    for (const child of definitionTreeNode.childrenSorted) {
      if (
        child.type === 'DestinyPresentationNodeDefinition' &&
        !child.definition?.displayProperties.hasIcon
      ) {
        for (const gc of child.childrenSorted) {
          definitionTreeNode.children.add(gc);
        }
        definitionTreeNode.children.delete(child);
        sortChildren(definitionTreeNode);
        reduceDepth(definitionTreeNode);
        return;
      }
    }
  }
  for (const child of definitionTreeNode.childrenSorted) {
    sortChildren(definitionTreeNode);
    reduceDepth(child);
  }
};

let definitionTreeRootNode: DefinitionTreeNode = {
  key: -1,
  type: 'DestinyPresentationNodeDefinition',
  children: new Set(),
  childrenSorted: [],
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
  const collectibles = (await fetchDefinition(
    contentPaths,
    lang,
    'DestinyCollectibleDefinition'
  )) as {
    [hash: number]: DestinyCollectibleDefinition;
  };
  const inventoryItems = (await fetchDefinition(
    contentPaths,
    lang,
    'DestinyInventoryItemDefinition'
  )) as {
    [hash: number]: DestinyInventoryItemDefinition;
  };

  const presentationNodeKeys = Object.keys(presentationNodes);
  presentationNodeKeys.sort(
    (a, b) => presentationNodes[Number(a)].index - presentationNodes[Number(b)].index
  );

  for (const key of presentationNodeKeys) {
    const node = presentationNodes[Number(key)];
    if (
      node?.parentNodeHashes?.length ||
      (!node?.children?.presentationNodes.length &&
        !node?.children?.collectibles.length &&
        !node?.children?.records.length)
    ) {
      continue;
    }
  }

  const definitionTreeNodeArray: DefinitionTreeNode[] = [];

  const recordKeys = Object.keys(records);
  recordKeys.sort((a, b) => records[Number(a)].index - records[Number(b)].index);

  for (const key of recordKeys) {
    const node = records[Number(key)];
    if (!node.loreHash) {
      continue;
    }
    const loreNode = lore[node.loreHash];
    const filtered = definitionTreeNodeArray.filter(
      (n) =>
        n.key === node.loreHash ||
        n.definition?.displayProperties.description === loreNode.displayProperties.description
    );
    if (!filtered.length) {
      let currentDefinitionTreeNode: DefinitionTreeNode = {
        key: node.loreHash,
        type: 'DestinyLoreDefinition',
        definition: loreNode,
        children: new Set(),
        childrenSorted: [],
      };
      definitionTreeNodeArray.push(currentDefinitionTreeNode);
      let currentNode: DestinyRecordDefinition | DestinyPresentationNodeDefinition = node;
      while (currentNode?.parentNodeHashes?.length) {
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
        sortChildren(parentDefinitionTreeNode);
        currentNode = parentNode;
        currentDefinitionTreeNode = parentDefinitionTreeNode;
      }
      definitionTreeRootNode.children.add(currentDefinitionTreeNode);
      sortChildren(definitionTreeRootNode);
    }
  }

  const collectibleKeys = Object.keys(collectibles);
  collectibleKeys.sort((a, b) => collectibles[Number(a)].index - collectibles[Number(b)].index);

  for (const key of collectibleKeys) {
    const node = collectibles[Number(key)];
    if (!node.itemHash) {
      continue;
    }
    const inventoryItemNode = inventoryItems[node.itemHash];
    if (!inventoryItemNode.loreHash) {
      continue;
    }
    const loreNode = lore[inventoryItemNode.loreHash];
    const filtered = definitionTreeNodeArray.filter(
      (n) =>
        n.key === inventoryItemNode.loreHash ||
        n.definition?.displayProperties.description === loreNode.displayProperties.description
    );
    if (!filtered.length) {
      let currentDefinitionTreeNode: DefinitionTreeNode = {
        key: inventoryItemNode.loreHash,
        type: 'DestinyLoreDefinition',
        definition: loreNode,
        inventoryItemDefinition: inventoryItemNode,
        collectibleDefinition: node,
        children: new Set(),
        childrenSorted: [],
      };
      definitionTreeNodeArray.push(currentDefinitionTreeNode);
      let currentNode: DestinyCollectibleDefinition | DestinyPresentationNodeDefinition = node;
      while (currentNode?.parentNodeHashes?.length) {
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
        sortChildren(parentDefinitionTreeNode);
        currentNode = parentNode;
        currentDefinitionTreeNode = parentDefinitionTreeNode;
      }
      definitionTreeRootNode.children.add(currentDefinitionTreeNode);
      sortChildren(definitionTreeRootNode);
    }
  }

  reduceDepth(definitionTreeRootNode);

  await addSection(definitionTreeRootNode);

  await fse.writeFile(`./txt/grimoire-${lang}.txt`, justText);
};

// do the thing
(async () => {
  const manifestMetadata = await getDestinyManifest(httpClient);

  const current = manifestMetadata.Response.version;
  let newREADME = `# d2-grimoire-epub\ngithub action for generating grimoire epub files when the d2 manifest is updated\n\n Current Manifest: ${current}\n\n# Downloads\n\n`;

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
  fse.emptyDirSync('./assets/screenshotsLarge');
  fse.emptyDirSync('./assets/screenshots');
  fse.emptyDirSync('./epub');
  fse.emptyDirSync('./txt');

  const contentPaths = manifestMetadata.Response.jsonWorldComponentContentPaths;
  for (const lang of Object.keys(contentPaths)) {
    definitionTreeRootNode = {
      key: -1,
      type: 'DestinyPresentationNodeDefinition',
      children: new Set(),
      childrenSorted: [],
    };
    await generateEpub(contentPaths, lang);
    newREADME = `${newREADME}- [grimoire-${lang}.epub](https://github.com/chrisfried/d2-grimoire-epub/raw/master/epub/grimoire-${lang}.epub)\n`;
  }
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
  definition?: DestinyLoreDefinition | DestinyPresentationNodeDefinition;
  inventoryItemDefinition?: DestinyInventoryItemDefinition;
  collectibleDefinition?: DestinyCollectibleDefinition;
  children: Set<DefinitionTreeNode>;
  childrenSorted: DefinitionTreeNode[];
}
