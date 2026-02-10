declare module 'nodepub' {
  export interface Metadata {
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

  export interface ContentsLink {
    title: string;
    link: string;
    itemType: 'front' | 'contents' | 'main';
  }

  export interface Document {
    addSection(
      title: string,
      content: string,
      excludeFromToc?: boolean,
      isFrontMatter?: boolean,
    ): void;
    addCSS(css: string): void;
    writeEPUB(outputDir: string, filename: string): Promise<void>;
  }

  export function document(
    metadata: Metadata,
    makeContentsCallback: (links: ContentsLink[]) => string,
  ): Document;
}
