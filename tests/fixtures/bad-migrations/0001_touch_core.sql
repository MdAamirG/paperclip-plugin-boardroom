-- Must be refused: plugin migrations may not mutate public core tables.
UPDATE public.agents SET name = 'hijacked';
