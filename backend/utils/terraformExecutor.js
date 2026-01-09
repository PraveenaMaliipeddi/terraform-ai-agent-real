// backend/utils/terraformExecutor.js
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);

// Base directory for Terraform workspaces
const WORKSPACE_BASE = path.join(__dirname, '..', 'terraform-workspaces');

// Ensure workspace directory exists
async function ensureWorkspaceDir() {
  try {
    await fs.mkdir(WORKSPACE_BASE, { recursive: true });
  } catch (error) {
    console.error('Failed to create workspace directory:', error);
  }
}

// Generate Terraform files for a specific action
async function generateTerraformFiles(actionId, terraformCode, credentials) {
  await ensureWorkspaceDir();
  
  const workDir = path.join(WORKSPACE_BASE, actionId);
  await fs.mkdir(workDir, { recursive: true });

  // Write main.tf
  await fs.writeFile(
    path.join(workDir, 'main.tf'),
    terraformCode
  );

  // Write provider.tf with user's credentials
  const providerConfig = `
terraform {
  required_version = ">= 1.0"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region     = "${credentials.region || 'us-east-1'}"
  access_key = "${credentials.accessKeyId}"
  secret_key = "${credentials.secretAccessKey}"
}
`;

  await fs.writeFile(
    path.join(workDir, 'provider.tf'),
    providerConfig
  );

  // Initialize Terraform
  console.log('Initializing Terraform in:', workDir);
  const initResult = await executeTerraform(workDir, 'init');
  
  if (!initResult.success) {
    throw new Error(`Terraform init failed: ${initResult.error}`);
  }

  return workDir;
}

// Execute Terraform commands
async function executeTerraform(workDir, command) {
  try {
    let cmd;
    
    switch (command) {
      case 'init':
        cmd = 'terraform init';
        break;
      case 'plan':
        cmd = 'terraform plan -no-color';
        break;
      case 'apply':
        cmd = 'terraform apply -auto-approve -no-color';
        break;
      case 'destroy':
        cmd = 'terraform destroy -auto-approve -no-color';
        break;
      case 'output':
        cmd = 'terraform output -json';
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }

    console.log(`Executing: ${cmd} in ${workDir}`);
    
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: workDir,
      timeout: 300000, // 5 minutes timeout
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });

    return {
      success: true,
      output: stdout,
      error: stderr
    };

  } catch (error) {
    console.error(`Terraform ${command} failed:`, error);
    
    return {
      success: false,
      output: error.stdout || '',
      error: error.stderr || error.message
    };
  }
}

// Clean up old workspaces
async function cleanupOldWorkspaces(maxAgeMinutes = 60) {
  try {
    await ensureWorkspaceDir();
    const workspaces = await fs.readdir(WORKSPACE_BASE);
    const now = Date.now();

    for (const workspace of workspaces) {
      const workspacePath = path.join(WORKSPACE_BASE, workspace);
      const stats = await fs.stat(workspacePath);
      const ageMinutes = (now - stats.mtimeMs) / 1000 / 60;

      if (ageMinutes > maxAgeMinutes) {
        console.log(`Cleaning up old workspace: ${workspace}`);
        await fs.rm(workspacePath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

// Run cleanup every hour
setInterval(() => {
  cleanupOldWorkspaces(60);
}, 60 * 60 * 1000);

module.exports = {
  generateTerraformFiles,
  executeTerraform,
  cleanupOldWorkspaces
};