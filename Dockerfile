# Dockerfile
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json (or pnpm-lock.yaml if using pnpm)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your code
COPY . .

# Build the project
RUN npm run build

# Expose the port your app runs on (change if needed)
EXPOSE 4111

# Start the app
CMD ["npm", "run", "start"]