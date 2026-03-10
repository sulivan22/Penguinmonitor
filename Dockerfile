FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm i --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 8080

CMD ["npm", "start"]
