# Flashka Kiosk

QR code generator and kiosk system for Flashka memory game with scan cooldown protection.

## Features
- QR code poster generation
- 1-hour scan cooldown per IP
- Statistics tracking
- PDF export
- Multi-sponsor ad pack support

## Environment Variables
- `GAME_URL` - URL of the game (default: https://flashka16.onrender.com)
- `FORCE_AD` - Force specific ad pack 1-7 (default: 3)
- `ADMIN_KEY` - Key for accessing stats
- `DATABASE_URL` - PostgreSQL connection (optional)

## Routes
- `/` - Main poster page
- `/kiosk/scan` - QR scan endpoint with cooldown
- `/kiosk/stats?key=ADMIN_KEY` - View statistics