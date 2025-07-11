
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { weatherWorkflow } from './workflows/weather-workflow';
import { gmailAgent } from './agents/gmail-agent';
import { recruitmentWorkflow } from './workflows/recruitment-workflow';
import { recruitAgentWorkflow } from './workflows/recruit-agent-workflow';

export const mastra = new Mastra({
  workflows: { weatherWorkflow, recruitmentWorkflow, recruitAgentWorkflow },
  agents: { gmailAgent },
  storage: new LibSQLStore({
    // stores telemetry, evals, ... into memory storage, if it needs to persist, change to file:../mastra.db
    url: "file:../mastra.db",
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
