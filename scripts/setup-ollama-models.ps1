# OpenBoard Ollama Models Setup Script
# Pulls all recommended models under 15GB

Write-Host "🦙 OpenBoard Ollama Models Setup" -ForegroundColor Magenta
Write-Host "=================================" -ForegroundColor Magenta
Write-Host ""

# Check if Ollama is installed
try {
    $ollamaVersion = ollama --version
    Write-Host "✓ Ollama detected: $ollamaVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ Ollama not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Ollama first:" -ForegroundColor Yellow
    Write-Host "  winget install Ollama.Ollama" -ForegroundColor Cyan
    Write-Host "  or download from: https://ollama.ai/download" -ForegroundColor Cyan
    exit 1
}

Write-Host ""
Write-Host "Available model categories:" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. 🥇 Best for Code (recommended)" -ForegroundColor Cyan
Write-Host "   - Qwen2.5-Coder 7B (4.5GB) ⭐ Top pick"
Write-Host "   - CodeLlama 13B (7.4GB)"
Write-Host "   - DeepSeek-Coder-V2 16B (8.9GB)"
Write-Host ""
Write-Host "2. 🦙 General Purpose" -ForegroundColor Cyan
Write-Host "   - Llama 3.1 8B (4.7GB)"
Write-Host "   - Gemma2 9B (5.4GB)"
Write-Host "   - Phi-3 Medium 14B (7.9GB)"
Write-Host ""
Write-Host "3. ⚡ Fast & Compact" -ForegroundColor Cyan
Write-Host "   - Mistral 7B (4.1GB)"
Write-Host "   - Phi-3 Mini (2.3GB)"
Write-Host "   - Llama 3.2 3B (2GB)"
Write-Host ""

Write-Host "What would you like to install?" -ForegroundColor Yellow
Write-Host ""
Write-Host "  [1] Just the best (Qwen2.5-Coder 7B) ~5GB" -ForegroundColor Green
Write-Host "  [2] Top 3 code models ~20GB"
Write-Host "  [3] All code models ~25GB"
Write-Host "  [4] All recommended models ~50GB"
Write-Host "  [5] Custom selection"
Write-Host "  [Q] Quit"
Write-Host ""

$choice = Read-Host "Enter choice (1-5 or Q)"

switch ($choice) {
    "1" {
        Write-Host ""
        Write-Host "📥 Pulling Qwen2.5-Coder 7B (best code model)..." -ForegroundColor Cyan
        ollama pull qwen2.5-coder:7b
        Write-Host "✅ Done! Use 'ollama run qwen2.5-coder:7b' to test" -ForegroundColor Green
    }
    
    "2" {
        Write-Host ""
        Write-Host "📥 Pulling top 3 code models..." -ForegroundColor Cyan
        
        Write-Host "1/3: Qwen2.5-Coder 7B (best)" -ForegroundColor Yellow
        ollama pull qwen2.5-coder:7b
        
        Write-Host "2/3: CodeLlama 13B (Python/JS)" -ForegroundColor Yellow
        ollama pull codellama:13b
        
        Write-Host "3/3: CodeLlama 7B (fast)" -ForegroundColor Yellow
        ollama pull codellama:7b
        
        Write-Host "✅ All top code models installed!" -ForegroundColor Green
    }
    
    "3" {
        Write-Host ""
        Write-Host "📥 Pulling all code models..." -ForegroundColor Cyan
        
        $codeModels = @(
            "qwen2.5-coder:7b",
            "deepseek-coder-v2:16b",
            "codellama:13b",
            "codellama:7b",
            "yi-coder:9b"
        )
        
        $i = 1
        foreach ($model in $codeModels) {
            Write-Host "$i/$($codeModels.Count): $model" -ForegroundColor Yellow
            ollama pull $model
            $i++
        }
        
        Write-Host "✅ All code models installed!" -ForegroundColor Green
    }
    
    "4" {
        Write-Host ""
        Write-Host "📥 Pulling ALL recommended models (this will take a while)..." -ForegroundColor Cyan
        
        $allModels = @(
            "qwen2.5-coder:7b",
            "deepseek-coder-v2:16b",
            "codellama:13b",
            "codellama:7b",
            "yi-coder:9b",
            "llama3.1:8b",
            "llama3.2:3b",
            "gemma2:9b",
            "phi3:14b",
            "mistral:7b",
            "phi3:mini",
            "qwen2.5:7b"
        )
        
        $i = 1
        foreach ($model in $allModels) {
            Write-Host "$i/$($allModels.Count): $model" -ForegroundColor Yellow
            ollama pull $model
            $i++
        }
        
        Write-Host "✅ All models installed! 🎉" -ForegroundColor Green
    }
    
    "5" {
        Write-Host ""
        Write-Host "Custom installation - enter model names separated by commas" -ForegroundColor Yellow
        Write-Host "Example: qwen2.5-coder:7b,mistral:7b,llama3.1:8b" -ForegroundColor Gray
        Write-Host ""
        
        $customModels = Read-Host "Enter models"
        $modelList = $customModels -split ','
        
        foreach ($model in $modelList) {
            $model = $model.Trim()
            Write-Host "📥 Pulling $model..." -ForegroundColor Cyan
            ollama pull $model
        }
        
        Write-Host "✅ Custom models installed!" -ForegroundColor Green
    }
    
    default {
        Write-Host "Exiting..." -ForegroundColor Gray
        exit 0
    }
}

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Magenta
Write-Host "🎉 Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Test a model:" -ForegroundColor Yellow
Write-Host "  ollama run qwen2.5-coder:7b 'Write a Python hello world'" -ForegroundColor Cyan
Write-Host ""
Write-Host "List installed models:" -ForegroundColor Yellow
Write-Host "  ollama list" -ForegroundColor Cyan
Write-Host ""
Write-Host "Use with OpenBoard:" -ForegroundColor Yellow
Write-Host "  openboard" -ForegroundColor Cyan
Write-Host "  → Select Ollama" -ForegroundColor Gray
Write-Host "  → Select your model from the menu" -ForegroundColor Gray
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Magenta
