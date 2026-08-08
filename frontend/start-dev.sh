#!/bin/bash

# RadSysX Development Startup Script
# Questo script verifica che tutto sia configurato correttamente prima di avviare

echo "🏥 RadSysX - Starting Development Environment"
echo "=============================================="

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: Run this script from the frontend directory"
    exit 1
fi

# Check dependencies
echo "📦 Checking dependencies..."
if [ ! -d "node_modules" ]; then
    echo "⚡ Installing dependencies..."
    npm install
fi

# Type check
echo "🔍 Running TypeScript check..."
npm run type-check
if [ $? -ne 0 ]; then
    echo "❌ TypeScript errors found. Please fix them before starting."
    exit 1
fi

# Build check
echo "🏗️ Running build check..."
npm run build
if [ $? -ne 0 ]; then
    echo "❌ Build failed. Please check your code."
    exit 1
fi

echo "✅ All checks passed!"
echo ""
echo "🚀 Starting development server..."
echo "   - Frontend: http://localhost:3000"
echo "   - Cornerstone 3D: Initialized"
echo "   - AI Agents: Ready"
echo ""

# Start development server
npm run dev 