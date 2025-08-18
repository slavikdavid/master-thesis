# Master's Thesis: bytesophos

Official repository of master's thesis "Implementing a Retrieval Augmented Generation System" (2025) by David Slavik, student of University of Zagreb Faculty of Informatics.

## Description

Goal of the project is to build a RAG system which will be useful for providing answers to questions regarding a codebase of a small to medium scale project.

Users can upload their codebase as a zip file or provide the GitHub repo link. After that, all the relevant files in the provided codebase are downloaded on backend and the relevant ones such as code, text, images are indexed in Postgres database (thanks to PgVector extension).

Once the indexing of files is finished, users can start asking questions in a chat interface. LLM which is used is `qwen/qwen3-32b` by Alibaba Cloud because of its logical reasoning and coding capabilities. Because the documents are indexed in PgVector document store, agent will understand the context of provided codebase and will take it into account when answering queries.

Conversation history is stored and users can bookmark or delete their conversations.

## Technologies

[![React](https://img.shields.io/badge/React-%2320232a.svg?logo=react&logoColor=%2361DAFB)](#)
[![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=fff)](#)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-%2338B2AC.svg?logo=tailwind-css&logoColor=white)](#)
[![shadcn/ui](https://img.shields.io/badge/shadcn%2Fui-000?logo=shadcnui&logoColor=fff)](#)
[![Postgres](https://img.shields.io/badge/Postgres-%23316192.svg?logo=postgresql&logoColor=white)](#)
[![FastAPI](https://img.shields.io/badge/FastAPI-009485.svg?logo=fastapi&logoColor=white)](#)
![Haystack](https://img.shields.io/badge/Haystack-02af9c.svg?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC0AAAAtCAMAAAANxBKoAAAARVBMVEVHcEz8/v7////////7///8//7////+///9///2/v37///7/v75/v7////+///+///9//79//7////+///+///9//7///+ai2leAAAAFnRSTlMAEtLmJjfx3ocEIBkM+ruXSl/1qch0qCxHkAAAAQJJREFUSMftlMu2gyAMRUGgvF8C/f9PLaTaeu8SC6NOekbBbJKziIDQT2OScpik0SeXRFQDMPPk/hT39ANrys4CHy8dGW/vR1lxgUuxU+u2y5Y+HVZAcgksiAViwnowzi2/Cg0rLaB+Mh06Qvpl9elrDR06tazDQEIvB7s7RsBprJHyDuxAM3duhbajvtWJyNbE71+4Pp/ireXqvBWvwYK3boRe0HorOUyrcVrN1LbOe2dH6Ze+T3POyTBNmNYQNNrkmfNGfmaWiPFrOpsjjUK2RPXpgv7QCIdw/seyeisT/kd3RbMrUEeN0FKbwyX6RL8lpmjlZmikxOLMxAuOMfppSA8uqB31LC7QvgAAAABJRU5ErkJggg==)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=fff)](#)
![Groq](https://img.shields.io/badge/Groq-f85434.svg?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC0AAAAtCAMAAAANxBKoAAAATlBMVEVHcEz///////////////////////////////////////////////////////////////////////////////////////////////////+IpfdaAAAAGXRSTlMACdO+3RX3SwMj5e49hbUbMKRUDMlnlXnD+x6mlwAAAXRJREFUSMeVldkSgyAMRdlkExHEpf7/j7biMlYIpfcRzlxIIAlCD2HTUc1XrmlnAioLD7ZdT7V2wCXYeb7exb2DYcHWp5iA4EGvqdoBcD5hzkY6svNOOuuuyGHmBxVwUIM/4iUqheW8741Cniti3JdmmdBmd6J3I2X30wxg/X2qPG6XmKuYPP5MwBBjZSq7bJ9vjW3WpItHTkk4U1zvHtf2MZz0nV0M3svMiaxP6D7GQ79/F6YA3ZAMLaO3VnU08vlnAOglxr5U0iLme2zq6H01TXiePp5Hmzra7bVATBV9xLnqqamhG3qU1rgY1W8KBRo5cjUGzTYtJRoZ8l3uXZFGjv5Do6bTf9Af+47wevrzo8Xi6WvTdP1vW+qeEodNGKodUNm6BPt5vuahtsuBCix00hnaN/c/qCjQB6/pwKZQ0WOvUcLt9Lt/3+eO/j0bEAo2M3c0lD3pXglMBJyxfm7r5+XH3nh9m8UC/3gQ6RbLjjmfsG/kDjj80CTTtwAAAABJRU5ErkJggg==)

### Frontend

**React** - JS library for creating user interfaces

**Vite** - JS bundler

**TailwindCSS** - framework which allows CSS styling directly within HTML by providing utility classes

**shadcdn/ui** - free and open source accessible and customizable UI components

### Backend

**Postgres** - RSQL database which supports storing vector embeddings using PgVector extension

**FastAPI** - framework for creating API in python

**Haystack** - python framework for building AI pipelines and applications

**Docker** - for automated deployment of applications in containers

**Groq** - low-cost, high performance inference platform which provides API to various LLMs

## Prerequisites (on the host)

- **Docker**
- **Docker Compose**
- **Git** (if cloning the repository)
  > You do **not** need to install Python, Node, or other language runtimes manually — the services are containerized

## Building and running

Before building, it is necessary to create a `.env` file in root directory of the project which will contain environment variables and their values. Add your values without `<>` signs.

```ini
GROQ_API_KEY=<your_groq_api_key>
VOYAGE_API_KEY=<your_voyage_api_key>
VOYAGE_MODEl=<voyage-code-2 OR voyage-code-3>

POSTGRES_USER=<your_db_user>
POSTGRES_PASSWORD=<your_db_password>
POSTGRES_DB=<your_db_name>
DATABASE_DSN=postgresql://<user>:<password>@<host>:<port>/<dbname>

JWT_SECRET=<replace_with_a_random_secret>
JWT_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=1440

UPLOAD_DIR=uploads
DATA_DIR=data/repos
```

To build the application, simply run the following command:

`docker-compose up --build`.

This command will install necessary tools and build frontend & backend images from instruction files `Dockerfile.frontend`, `Dockerfile.backend`.

Backend will be available on port 3001 and frontend on port 5173.

To start using the app, just visit `http://localhost:5173`.

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.
