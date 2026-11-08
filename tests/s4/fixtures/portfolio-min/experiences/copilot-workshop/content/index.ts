import { breakOne } from './interludes';
import { m1 } from './m1';
import type { Course } from './types';

export const course: Course = {
  title: 'Advanced workshop',
  tagline: 'A small stand-in course',
  modules: [m1, breakOne],
};
