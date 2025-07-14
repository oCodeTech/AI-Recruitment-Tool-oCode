# recruit-ai-agent

This project is an AI-powered recruitment workflow using Mastra AI agents to automate initial email screening, validate candidate submissions (resume/cover letter), and send appropriate responses. The system is designed to be modular, context-aware, and easily extendable.

## Tech Stack
- Mastra AI
- Node.js
- Redis
- BullMQ
- Gmail API
- TypeScript

## Installation
1. Clone the repository using `git clone git@github.com:togetherai/recruit-ai-agent.git`
2. Install the dependencies using `npm install` or `yarn install`
3. Set up your Gmail account with the necessary permissions using the `OAuth2.0` method.
4. Create a `.env` file with the following variables:
    - `RECRUITMENT_MAIL`: The Gmail email address to be used for the recruitment workflow
    - `REDISCLOUD_URL`: The Redis Cloud URL to be used for storing the job application data
    - `GMAIL_CLIENT_ID`: The Gmail API client ID
    - `GMAIL_CLIENT_SECRET`: The Gmail API client secret
   . Create a job application database in your Redis Cloud instance.
5. Run the application using `npm run start` or `yarn start`
6. The application will start the Mastra AI agent and the BullMQ job queue.

## Usage
1. Send an email to the `RECRUITMENT_MAIL` address with the job application details.
2. The system will automatically create a job application database in your Redis Cloud instance.
3. The system will then validate the candidate submissions (resume/cover letter) and send appropriate responses.

## Configuration
The system can be configured using the following environment variables:
- `RECRUITMENT_MAIL`: The Gmail email address to be used for the recruitment workflow
- `REDISCLOUD_URL`: The Redis Cloud URL to be used for storing the job application data
- `GMAIL_CLIENT_ID`: The Gmail API client ID
- `GMAIL_CLIENT_SECRET`: The Gmail API client secret
- `BULLMQ_REDIS_URL`: The Redis URL to be used for the BullMQ job queue
- `BULLMQ_CONCURRENCY`: The number of concurrent jobs to be processed by the BullMQ job queue
- `BULLMQ_REDIS_KEY_PREFIX`: The key prefix to be used for the BullMQ job queue in Redis
