import * as z from 'zod';
import { isThreadId, MAX_THREAD_ID_CHARS } from '../threadId.js';

export const threadIdSchema = z.string().min(1).max(MAX_THREAD_ID_CHARS).refine(isThreadId, 'Invalid T3 thread id');
