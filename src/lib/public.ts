import { unstable_cache } from 'next/cache';
import { publishedLayout } from './placement/service';

/** The published wall, cached until the next Publish (tag "layout"). */
export const getPublishedLayout = unstable_cache(async () => publishedLayout(), ['published-layout'], { tags: ['layout'], revalidate: 300 });
