-- GIS-1.1: additive nullable column; null = unknown (never treated as "all").
ALTER TABLE "GitHubRepoSnapshot" ADD COLUMN "repositorySelection" TEXT;
