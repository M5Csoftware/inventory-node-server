# M5C Inventory & Invoice Management Backend Server

Dedicated standalone backend service for **Inventory Management** and **Invoice Registration**.

## Features
- Independent microservice decoupled from `m5-software` and `m5-node-server`.
- Handles all inventory operations (`/api/inventory/*`): products, orders, stock movements, assets, asset serials, suppliers, categories, audit logs.
- Handles invoice registration (`/api/invoice-registration/*`): invoices, fraud detection, config.
- Fastify v5 with response compression and high performance.
- Multi-tenant / tenant-aware database support (`m5c-inventory`).

## Endpoints

| Service | Base Route |
|---|---|
| Health Check | `GET /` & `GET /health` |
| Inventory API | `/api/inventory` |
| Invoice Registration API | `/api/invoice-registration` |

## Setup & Running Locally

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables in `.env`:
   ```env
   MONGODB_URI="mongodb+srv://.../m5c-inventory?..."
   PORT=5000
   FRONTEND_URL="*"
   JWT_SECRET="your-jwt-secret"
   ```

3. Start development server:
   ```bash
   npm run dev
   ```

## Deploying to Render as a Separate Web Service

1. Create a new GitHub repository from this folder: `inventory-node-server`.
2. On [Render](https://render.com), click **New +** -> **Web Service**.
3. Connect your repository `inventory-node-server`.
4. Configure settings:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Environment Variables**:
     - `MONGODB_URI` = (your mongo connection string to `m5c-inventory`)
     - `PORT` = `10000` (or leave default for Render)
     - `FRONTEND_URL` = `*` (or your inventory-management frontend domain)
     - `JWT_SECRET` = (your secret)
     - `INVENTORY_MANAGEMENT_MASTER_ADMIN_EMAIL` = `master@m5clogs.com`
     - `INVENTORY_MANAGEMENT_MASTER_ADMIN_PASSWORD` = `m5c@master123`
5. Update your `inventory-management` frontend environment variable:
   ```env
   NEXT_PUBLIC_API_URL=https://<your-inventory-render-service>.onrender.com/api/inventory
   ```
