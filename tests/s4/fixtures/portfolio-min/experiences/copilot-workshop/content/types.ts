export interface Slide {
  id: string;
  title: string;
  lead?: string;
  minutes: number;
  blocks: string[];
  script: string[];
}

export interface Module {
  id: string;
  code: string;
  kind: 'module' | 'interlude';
  title: string;
  minutes: number;
  slides: Slide[];
}

export interface Course {
  title: string;
  tagline: string;
  modules: Module[];
}

export interface Finding {
  level: 'error' | 'warn';
  rule: string;
  where: string;
  message: string;
}
