<img width="1370" height="838" alt="image" src="https://github.com/user-attachments/assets/67e0cb80-e2e9-4b29-b683-0ddc2ee9c613" />

# Linux Server Monitor Dashboard

Dashboard web para monitorizar servidores Linux por SSH, con persistencia en MongoDB para hosts e historico de metricas.

## Funcionalidades

- Persistencia en MongoDB:
  - Hosts guardados en base de datos
  - Historico CPU/RAM por host guardado en base de datos
- Conexion SSH por host:
  - Password
  - SSH key (passphrase opcional)
- Home (resumen global):
  - Total hosts
  - Online
  - CPU media
  - RAM media
  - Tabla por host (uptime, containers, ultima lectura)
- Vista por host:
  - Recursos en circulos (CPU, RAM, uptime, ratio containers)
  - Historico CPU y RAM con graficas y rango seleccionable (`1h`, `6h`, `24h`, `7d`, `14d`)
  - Tabla Docker con Start/Stop/Logs
- Autorefresco silencioso cada 30s
- Cambio de host refresca automaticamente
- CPU corregida:
  - Calculada con 2 lecturas de `/proc/stat` separadas por 1s

## API principal

- `GET /api/hosts`
- `POST /api/hosts`
- `DELETE /api/hosts/:id`
- `GET /api/home/summary`
- `GET /api/hosts/:id/detail`
- `GET /api/hosts/:id/history?range=1h|6h|24h|7d|14d&limit=240`
- `POST /api/hosts/:id/fetch`
- `POST /api/hosts/:id/containers/action`
- `POST /api/hosts/:id/containers/logs`

## Requisitos servidor remoto

- SSH accesible
- Comandos base: `free`, `cat`
- Docker instalado para funciones de contenedores
- Usuario SSH con permisos para `docker ps -a`, `docker start`, `docker stop`

## Ejecutar con Docker (recomendado)

```bash
docker compose up --build -d
```

Abrir:
- `http://localhost:8080`
- o `http://IP_DE_TU_SERVIDOR:8080`

## Variables de entorno

Se cargan en este orden:
1. `.env`
2. `.env.local` (sobrescribe `.env`)

Variables requeridas:
- `MONGODB_URI`
- `CREDENTIALS_ENCRYPTION_KEY` (clave usada para cifrar/descifrar credenciales SSH con AES-256-GCM)

Para preparar entorno local:

```bash
cp .env.example .env.local
```

Ejemplo para generar una clave robusta:

```bash
openssl rand -base64 32
```

## Ejecutar sin Docker

Necesitas MongoDB corriendo y exportar `MONGODB_URI`.

```bash
export MONGODB_URI="mongodb://127.0.0.1:27017/dashboard_monitor"
npm i
npm start
```

## Notas

- Las credenciales SSH (`password`, `privateKey`, `passphrase`) se guardan cifradas en MongoDB con AES-256-GCM.
- No subas `.env` ni `.env.local` a GitHub (ya estan en `.gitignore`).
- Para produccion: cifrar secretos, RBAC, auditoria y HTTPS.
