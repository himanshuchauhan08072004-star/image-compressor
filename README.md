# Shrinkit

A small, free image compressor that runs entirely in your browser. No server, no upload, no sign-up.

## LIVE :- https://image-compressor-seven-theta.vercel.app/

## Why I built this

I've lost count of how many times I've hit a "file too large" error trying to upload a phone photo to a job application form, a college portal, or a WhatsApp group with a size cap. Most online compressors send your photo to a server first, which felt unnecessary for something the browser can already do. So I built one that does it locally instead.

## How it works

- Drop in a JPG, PNG, or WEBP image
- It's drawn onto an HTML5 `<canvas>` and re-encoded at an adjustable quality level using `canvas.toBlob()`
- You see the original and compressed file size side by side, and how much smaller the result is
- Download the compressed file directly — nothing is ever sent off your device

## Stack

Plain HTML, CSS, and vanilla JavaScript. No frameworks, no build step. Deploys as a static site on Vercel's free Hobby plan.

## Running it locally

Just open `index.html` in a browser, or serve the folder with any static server:

```bash
npx serve .
```

## Author

## Himanshu Chauhan — himanshuchauhan08072004@gmail.com
