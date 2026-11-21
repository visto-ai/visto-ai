alter table visto_ai.review_runs add column base_branch text;

create table visto_ai.block_scores (
  id integer generated always as identity primary key,
  run integer not null,
  service text not null, owner text not null, repo text not null, number integer not null,
  path text not null, hash text not null,
  score integer not null check (score between 0 and 100),
  category text not null,
  reason text not null,
  scored_by text not null,
  scored_at timestamptz not null
);
create index block_scores_block on visto_ai.block_scores (service, owner, repo, path, hash, scored_at);
