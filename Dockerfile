FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# tsx runs the TypeScript directly, so dev dependencies stay installed
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
EXPOSE 3000
CMD ["npm", "start"]
