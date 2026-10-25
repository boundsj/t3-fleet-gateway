import * as z from 'zod';
import { isThreadId, MAX_THREAD_ID_CHARS } from '../threadId.js';

export const threadIdSchema = z.string().min(1).max(MAX_THREAD_ID_CHARS).refine(isThreadId, 'Invalid T3 thread id');

/** Response ids are opaque: preserve unfamiliar formats so existing work stays observable and operable. */
export const responseThreadIdSchema = z.string().min(1).max(MAX_THREAD_ID_CHARS)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/, 'T3 thread ids cannot contain control characters')
  .refine((value) => value.trim().length > 0, 'T3 thread ids cannot be blank');
