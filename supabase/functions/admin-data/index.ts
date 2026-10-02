import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('admin-data', (name: string) => Deno.env.get(name)));
