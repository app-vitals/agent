-- PMK-1.1: AgentMarketplace table for per-agent plugin marketplaces (additive only).
-- CreateTable
CREATE TABLE "AgentMarketplace" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ref" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMarketplace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentMarketplace_agentId_name_key" ON "AgentMarketplace"("agentId", "name");

-- AddForeignKey
ALTER TABLE "AgentMarketplace" ADD CONSTRAINT "AgentMarketplace_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
