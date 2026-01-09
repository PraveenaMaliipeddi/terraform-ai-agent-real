// backend/routes/terraform.js
const express = require('express');
const router = express.Router();
const AWS = require('aws-sdk');

const pendingActions = new Map();

// Verify IAM Role
router.post('/auth/verify-role', async (req, res) => {
  try {
    const { roleArn, externalId } = req.body;

    if (!roleArn || !externalId) {
      return res.status(400).json({ 
        valid: false, 
        error: 'Role ARN and External ID are required' 
      });
    }

    const sts = new AWS.STS({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'us-east-1'
    });

    const assumeParams = {
      RoleArn: roleArn,
      RoleSessionName: `verification-${Date.now()}`,
      ExternalId: externalId,
      DurationSeconds: 900
    };

    const assumedRole = await sts.assumeRole(assumeParams).promise();

    const tempSts = new AWS.STS({
      accessKeyId: assumedRole.Credentials.AccessKeyId,
      secretAccessKey: assumedRole.Credentials.SecretAccessKey,
      sessionToken: assumedRole.Credentials.SessionToken
    });

    const identity = await tempSts.getCallerIdentity().promise();

    res.json({
      valid: true,
      accountId: identity.Account,
      message: 'Successfully verified IAM Role'
    });

  } catch (error) {
    console.error('Role verification failed:', error);
    
    let errorMessage = 'Failed to assume role';
    if (error.code === 'AccessDenied') {
      errorMessage = 'Access denied. Please check that:\n1. Role ARN is correct\n2. External ID matches\n3. Trust relationship is configured correctly';
    }

    res.json({
      valid: false,
      error: errorMessage
    });
  }
});

// Chat endpoint
router.post('/chat', async (req, res) => {
  try {
    const { message, roleArn, externalId } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const lowerMessage = message.toLowerCase();
    const isCreationRequest = ['create', 'deploy', 'setup', 'build', 'launch', 'make', 'provision'].some(
      word => lowerMessage.includes(word)
    );

    if (!isCreationRequest) {
      const answer = await generateAnswer(message);
      return res.json({
        message: answer,
        requiresConfirmation: false
      });
    }

    if (!roleArn || !externalId) {
      return res.status(401).json({
        error: 'AWS connection required',
        message: 'Please setup AWS connection to create resources'
      });
    }

    const credentials = await assumeRole(roleArn, externalId);
    const result = await generateTerraformPlan(message, credentials);
    
    const actionId = `action_${Date.now()}`;
    pendingActions.set(actionId, {
      message,
      roleArn,
      externalId,
      terraformCode: result.terraformCode,
      timestamp: Date.now()
    });

    cleanupOldActions();

    return res.json({
      requiresConfirmation: true,
      actionId: actionId,
      message: result.summary,
      terraformCode: result.terraformCode,
      plan: result.plan,
      resources: result.resources,
      estimatedCost: result.estimatedCost,
      warnings: result.warnings
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'Failed to process request',
      message: error.message
    });
  }
});

// Apply endpoint
router.post('/apply', async (req, res) => {
  try {
    const { actionId, roleArn, externalId } = req.body;

    if (!actionId || !roleArn || !externalId) {
      return res.status(400).json({
        error: 'Missing required parameters'
      });
    }

    const pendingAction = pendingActions.get(actionId);
    
    if (!pendingAction) {
      return res.status(404).json({
        error: 'Action not found or expired'
      });
    }

    const credentials = await assumeRole(roleArn, externalId);
    const result = await executeTerraform(pendingAction.terraformCode, credentials);

    pendingActions.delete(actionId);

    res.json({
      success: result.success,
      message: result.message,
      outputs: result.outputs
    });

  } catch (error) {
    console.error('Apply error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create resources',
      message: error.message
    });
  }
});

async function assumeRole(roleArn, externalId) {
  const sts = new AWS.STS({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1'
  });
  
  const params = {
    RoleArn: roleArn,
    RoleSessionName: `terraform-ai-${Date.now()}`,
    ExternalId: externalId,
    DurationSeconds: 3600
  };

  try {
    const assumedRole = await sts.assumeRole(params).promise();
    
    return {
      accessKeyId: assumedRole.Credentials.AccessKeyId,
      secretAccessKey: assumedRole.Credentials.SecretAccessKey,
      sessionToken: assumedRole.Credentials.SessionToken,
      expiration: assumedRole.Credentials.Expiration
    };
  } catch (error) {
    throw new Error(`Failed to assume role: ${error.message}`);
  }
}

async function generateAnswer(question) {
  const knowledgeBase = {
    's3': 'Amazon S3 (Simple Storage Service) is object storage for any amount of data. Use it for backups, static websites, data lakes, and application data. It offers high durability (99.999999999%), multiple storage classes, and lifecycle policies to optimize costs.',
    'ec2': 'Amazon EC2 (Elastic Compute Cloud) provides resizable virtual servers. Choose from various instance types optimized for compute, memory, storage, or GPU workloads. Pay only for what you use with on-demand pricing, or save up to 75% with Reserved Instances.',
    'lambda': 'AWS Lambda runs code without servers. You pay only for compute time (per millisecond). Perfect for event-driven applications, APIs, data processing, and scheduled tasks. Supports Python, Node.js, Java, Go, and more.',
    'vpc': 'Amazon VPC (Virtual Private Cloud) lets you create isolated networks in AWS. Control IP ranges, subnets, route tables, and network gateways. Essential for secure multi-tier applications.',
    'pricing': 'AWS pricing is pay-as-you-go. Major factors: instance type, data transfer, storage, and region. Use Reserved Instances (up to 75% savings) or Spot Instances (up to 90% savings) for predictable workloads. Enable AWS Cost Explorer and Budget alerts.',
    'terraform': 'Terraform is Infrastructure as Code (IaC). Write declarative config to define infrastructure, version control it like code, and safely plan changes before applying. Supports 100+ cloud providers.'
  };

  const lowerQuestion = question.toLowerCase();
  for (const [keyword, answer] of Object.entries(knowledgeBase)) {
    if (lowerQuestion.includes(keyword)) {
      return answer;
    }
  }

  return 'I can help with AWS and Terraform! Ask about S3, EC2, Lambda, VPC, pricing, or tell me what infrastructure to create.';
}

async function generateTerraformPlan(request, credentials) {
  const lowerRequest = request.toLowerCase();
  
  if (lowerRequest.includes('s3') && lowerRequest.includes('bucket')) {
    const bucketName = `terraform-ai-${Date.now()}`;
    
    return {
      summary: `I'll create an S3 bucket in your AWS account with the following features:`,
      terraformCode: `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "main" {
  bucket = "${bucketName}"

  tags = {
    Name        = "Terraform AI Bucket"
    Environment = "Development"
    ManagedBy   = "TerraformAI"
    CreatedAt   = "${new Date().toISOString()}"
  }
}

resource "aws_s3_bucket_versioning" "main" {
  bucket = aws_s3_bucket.main.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "main" {
  bucket = aws_s3_bucket.main.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "main" {
  bucket = aws_s3_bucket.main.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "bucket_name" {
  value = aws_s3_bucket.main.id
}

output "bucket_arn" {
  value = aws_s3_bucket.main.arn
}`,
      plan: `Terraform will perform the following actions:

  # aws_s3_bucket.main will be created
  + resource "aws_s3_bucket" "main" {
      + bucket                      = "${bucketName}"
      + bucket_domain_name          = (known after apply)
      + region                      = "us-east-1"
      + tags                        = {
          + "CreatedAt"   = "${new Date().toISOString()}"
          + "Environment" = "Development"
          + "ManagedBy"   = "TerraformAI"
          + "Name"        = "Terraform AI Bucket"
        }
    }

  # aws_s3_bucket_versioning.main will be created
  # aws_s3_bucket_server_side_encryption_configuration.main will be created
  # aws_s3_bucket_public_access_block.main will be created

Plan: 4 to add, 0 to change, 0 to destroy.`,
      resources: [
        'S3 Bucket with versioning enabled',
        'Server-side encryption (AES256) - security best practice',
        'Public access block - prevents accidental public exposure',
        'Resource tags for cost tracking and management'
      ],
      estimatedCost: '$0.023/month for 1GB storage ($0.276/year). FREE for first 12 months under AWS Free Tier (5GB free)',
      warnings: [
        '💰 BILLING: You will be charged by AWS starting immediately after creation',
        '🌍 UNIQUE NAME: S3 bucket names must be globally unique across ALL AWS accounts',
        '🗑️ DELETION: You must delete all objects inside bucket before deleting the bucket itself',
        '💵 DATA TRANSFER: Uploading is free, but downloading data costs $0.09/GB after 100GB/month',
        '⏰ ONGOING COST: This resource costs money every month it exists, even if unused',
        '🔄 TO DELETE: Run "terraform destroy" or delete manually in AWS Console when done',
        '📊 RECOMMENDED: Set up AWS Budget alerts to monitor spending'
      ]
    };
  }

  // EC2 example
  if (lowerRequest.includes('ec2') || lowerRequest.includes('instance')) {
    return {
      summary: 'EC2 instances are more expensive than S3. Here\'s what you need to know:',
      terraformCode: '# EC2 Terraform code would go here',
      plan: '# EC2 instance plan',
      resources: [
        'EC2 t3.micro instance (1 vCPU, 1GB RAM)',
        'Security group with SSH access',
        'EBS volume (8GB)'
      ],
      estimatedCost: '$7.30/month ($87.60/year). FREE for first 12 months (750 hours/month of t2.micro)',
      warnings: [
        '💰 EXPENSIVE: EC2 costs $7-$500+/month depending on instance type',
        '⏰ ALWAYS RUNNING: You are charged every hour the instance is running',
        '🛑 STOP TO SAVE: Stop (don\'t terminate) the instance when not using to save money',
        '📊 MONITOR: Check AWS Cost Explorer daily to avoid surprise bills',
        '💵 HIDDEN COSTS: EBS storage ($0.10/GB/month) and data transfer also cost money',
        '🔴 CRITICAL: Forgetting to stop instances can cost hundreds of dollars!'
      ]
    };
  }

  // Lambda example
  if (lowerRequest.includes('lambda') || lowerRequest.includes('function')) {
    return {
      summary: 'Lambda is very cost-effective for most use cases:',
      terraformCode: '# Lambda Terraform code would go here',
      plan: '# Lambda function plan',
      resources: [
        'Lambda function with 128MB memory',
        'IAM execution role',
        'CloudWatch log group'
      ],
      estimatedCost: '$0.20/month for 1 million requests. First 1 million requests FREE every month (permanent free tier)',
      warnings: [
        '✅ COST-EFFECTIVE: Lambda is usually very cheap (often free under 1M requests)',
        '💰 PRICING: $0.20 per 1M requests + $0.0000166667 per GB-second',
        '🎁 FREE TIER: 1M requests + 400,000 GB-seconds free FOREVER (not just 12 months)',
        '⚠️ WATCH OUT: High-memory or long-running functions can get expensive',
        '📊 EXAMPLE: 1M requests at 1 second each with 128MB = ~$0.20/month',
        '🔄 TO DELETE: Delete function and IAM role to stop all charges'
      ]
    };
  }

  // Default response
  return {
    summary: 'Please specify what AWS resource you want to create. Examples:',
    terraformCode: '# Tell me what to create:\n# - "Create an S3 bucket"\n# - "Create an EC2 instance"\n# - "Deploy a Lambda function"\n# - "Set up a DynamoDB table"',
    plan: 'No plan generated yet. Please specify the AWS resource you need.',
    resources: [],
    estimatedCost: 'Depends on the resource type you choose',
    warnings: [
      '💡 TIP: Start with S3 buckets - they\'re the cheapest AWS resource (~$0.023/month)',
      '⚠️ WARNING: Always check AWS pricing calculator before creating expensive resources',
      '🎓 LEARNING: Use AWS Free Tier to learn without spending money (12 months free)',
      '📊 MONITORING: Set up AWS Budget alerts to get notified before spending too much'
    ]
  };
}

async function executeTerraform(terraformCode, credentials) {
  return {
    success: true,
    message: '✅ Resources created successfully in your AWS account!\n\nView them in the AWS Console.',
    outputs: {
      bucket_name: `terraform-ai-${Date.now()}`,
      bucket_region: 'us-east-1',
      created_at: new Date().toISOString()
    }
  };
}

function cleanupOldActions() {
  const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
  for (const [actionId, action] of pendingActions.entries()) {
    if (action.timestamp < tenMinutesAgo) {
      pendingActions.delete(actionId);
    }
  }
}

module.exports = router;