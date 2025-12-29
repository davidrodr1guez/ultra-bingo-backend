# Ultra Bingo - Deployment Guide (Free Tier)

## Stack
- **Frontend**: Vercel (free)
- **Backend**: Render (free)
- **Database**: MongoDB Atlas (free - 512MB)

---

## Step 1: MongoDB Atlas (Database)

1. Go to [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas)
2. Create account / Sign in
3. Create a **FREE** cluster (M0 Sandbox)
   - Choose region closest to you
   - Name: `ultra-bingo`
4. Create database user:
   - Go to **Database Access** > Add New Database User
   - Username: `ultrabingo`
   - Password: (generate a strong password, save it!)
   - Role: `Read and write to any database`
5. Configure network access:
   - Go to **Network Access** > Add IP Address
   - Click **Allow Access from Anywhere** (0.0.0.0/0) for Render
6. Get connection string:
   - Go to **Database** > **Connect** > **Drivers**
   - Copy the connection string, replace `<password>` with your password
   - Example: `mongodb+srv://ultrabingo:PASSWORD@cluster0.xxxxx.mongodb.net/ultrabingo`

---

## Step 2: Deploy Backend on Render

1. Go to [render.com](https://render.com) and sign up with GitHub
2. Click **New** > **Web Service**
3. Connect your GitHub repo: `Felipe-Tabares/ultra-bingo-backend`
4. Configure:
   - **Name**: `ultra-bingo-backend`
   - **Region**: Oregon (or closest)
   - **Branch**: `main`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

5. Add Environment Variables (click **Advanced** > **Add Environment Variable**):

   | Key | Value |
   |-----|-------|
   | `NODE_ENV` | `production` |
   | `NODE_OPTIONS` | `--dns-result-order=ipv4first` |
   | `MONGODB_URI` | `mongodb+srv://ultrabingo:PASSWORD@...` (from Step 1) |
   | `JWT_SECRET` | (generate: `openssl rand -hex 32`) |
   | `ADMIN_PASSWORD` | (your admin password) |
   | `ADMIN_WALLETS` | `0xYourWallet1,0xYourWallet2` |
   | `X402_FACILITATOR_URL` | `https://facilitator.ultravioletadao.xyz` |
   | `X402_NETWORK` | `avalanche` |
   | `X402_RECEIVER_ADDRESS` | `0xYourReceiverWallet` |
   | `CARD_PRICE` | `0.001` |
   | `FRONTEND_URL` | `https://your-app.vercel.app` (update after Step 3) |

6. Click **Create Web Service**
7. Wait for deployment (2-3 min)
8. Copy your backend URL: `https://ultra-bingo-backend.onrender.com`

---

## Step 3: Deploy Frontend on Vercel

1. Go to [vercel.com](https://vercel.com) and sign up with GitHub
2. Click **Add New** > **Project**
3. Import: `Felipe-Tabares/ultra-bingo-frontend`
4. Configure:
   - **Framework Preset**: Vite
   - **Root Directory**: `./` (default)

5. Add Environment Variables:

   | Key | Value |
   |-----|-------|
   | `VITE_API_URL` | `https://ultra-bingo-backend.onrender.com` |
   | `VITE_WS_URL` | `wss://ultra-bingo-backend.onrender.com` |
   | `VITE_X402_FACILITATOR_URL` | `https://facilitator.ultravioletadao.xyz` |
   | `VITE_X402_NETWORK` | `avalanche` |
   | `VITE_X402_RECEIVER` | `0xYourReceiverWallet` (same as backend) |

6. Click **Deploy**
7. Copy your frontend URL: `https://your-app.vercel.app`

---

## Step 4: Update Backend CORS

1. Go back to Render dashboard
2. Update `FRONTEND_URL` environment variable with your Vercel URL
3. Render will auto-redeploy

---

## Verify Deployment

1. **Backend Health**: Visit `https://your-backend.onrender.com/health`
   - Should return: `{"status":"ok","timestamp":"..."}`

2. **Frontend**: Visit your Vercel URL
   - Should load the Ultra Bingo interface

3. **WebSocket**: Check browser console for connection

---

## Free Tier Limitations

### Render Free Tier:
- Spins down after 15 min of inactivity
- First request after sleep takes ~30 seconds
- 750 hours/month (enough for 1 service 24/7)

### MongoDB Atlas Free:
- 512MB storage
- Shared cluster (slower)
- Good for testing/low traffic

### Vercel Free:
- Unlimited for hobby projects
- 100GB bandwidth/month
- Serverless functions: 100GB-hours

---

## Quick Commands

```bash
# Generate JWT secret
openssl rand -hex 32

# Test backend locally before deploy
npm start

# Check Render logs
# Go to Render Dashboard > Your Service > Logs
```

---

## Troubleshooting

### Backend not starting
- Check Render logs for errors
- Verify MONGODB_URI is correct
- Make sure MongoDB Atlas allows all IPs (0.0.0.0/0)

### WebSocket not connecting
- Check FRONTEND_URL matches your Vercel domain
- Check browser console for CORS errors

### Slow first load
- Normal for Render free tier (cold start)
- Consider upgrading to paid tier ($7/month) for always-on

---

## Upgrade Path

When ready for production:
- **Render Starter**: $7/month (no sleep, better performance)
- **MongoDB Atlas M2**: $9/month (dedicated, faster)
- **Or**: Use AWS Terraform setup in `/terraform` folder
