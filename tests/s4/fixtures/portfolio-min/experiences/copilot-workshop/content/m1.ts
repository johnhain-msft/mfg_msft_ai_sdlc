import type { Module } from './types';

export const m1: Module = {
  id: 'm1-extensibility',
  code: 'M1',
  kind: 'module',
  title: 'Extensibility',
  minutes: 1,
  slides: [
    {
      id: 'm1-opening',
      title: 'What we extend',
      lead: 'Three ways to extend the tool.',
      minutes: 1,
      blocks: ['Agents', 'Skills', 'Hooks'],
      script: ['This module shows how the tool is extended in three ways. Agents give it roles, so each task meets a specialist with a clear brief. Skills give it procedures, so a repeated job is done the same way every time. Hooks give it guard rails that run on every call, so a rule is enforced rather than remembered. Together they turn one assistant into a team that follows your standards.'],
    },
  ],
};
