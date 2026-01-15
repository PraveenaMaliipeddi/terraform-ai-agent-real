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

    console.log('🔐 Verifying role:', roleArn);

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

    console.log('✅ Role verified for account:', identity.Account);

    res.json({
      valid: true,
      accountId: identity.Account,
      message: 'Successfully verified IAM Role'
    });

  } catch (error) {
    console.error('❌ Role verification failed:', error);
    
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

    console.log('💬 Chat message:', message);

    const lowerMessage = message.toLowerCase();
    const isCreationRequest = ['create', 'deploy', 'setup', 'build', 'launch', 'make', 'provision'].some(
      word => lowerMessage.includes(word)
    );

    // If not a creation request, just answer the question
    if (!isCreationRequest) {
      const answer = await generateAnswer(message);
      return res.json({
        message: answer,
        requiresConfirmation: false
      });
    }

    // Creation request - need AWS connection
    if (!roleArn || !externalId) {
      return res.status(401).json({
        error: 'AWS connection required',
        message: 'Please setup AWS connection to create resources'
      });
    }

    // Verify we can assume the role
    try {
      await assumeRole(roleArn, externalId);
    } catch (error) {
      return res.status(401).json({
        error: 'Failed to assume role',
        message: error.message
      });
    }

    // Generate plan
    const result = await generateTerraformPlan(message);
    
    const actionId = `action_${Date.now()}`;
    pendingActions.set(actionId, {
      message,
      roleArn,
      externalId,
      resourceType: result.resourceType,
      resourceConfig: result.resourceConfig,
      timestamp: Date.now()
    });

    cleanupOldActions();

    console.log('📋 Generated plan for action:', actionId);

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
    console.error('❌ Chat error:', error);
    res.status(500).json({
      error: 'Failed to process request',
      message: error.message
    });
  }
});

// Apply endpoint - ACTUALLY CREATES RESOURCES
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

    console.log('🚀 Executing action:', actionId);
    console.log('📦 Resource type:', pendingAction.resourceType);

    // Get credentials by assuming role
    const credentials = await assumeRole(roleArn, externalId);

    // ACTUALLY CREATE THE RESOURCE
    const result = await createAWSResource(
      pendingAction.resourceType,
      pendingAction.resourceConfig,
      credentials
    );

    pendingActions.delete(actionId);

    console.log('✅ Resource created:', result.resourceId);

    res.json({
      success: true,
      message: result.message,
      outputs: result.outputs
    });

  } catch (error) {
    console.error('❌ Apply error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create resources',
      message: error.message
    });
  }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

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

async function generateTerraformPlan(request) {
  const lowerRequest = request.toLowerCase();
  
  if (lowerRequest.includes('s3') && lowerRequest.includes('bucket')) {
    const bucketName = `terraform-ai-${Date.now()}`;
    
    return {
      resourceType: 's3-bucket',
      resourceConfig: { bucketName },
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
    }

Plan: 3 to add, 0 to change, 0 to destroy.`,
      resources: [
        'S3 Bucket with versioning enabled',
        'Server-side encryption (AES256)',
        'Resource tags for management'
      ],
      estimatedCost: '$0.023/month for 1GB storage. FREE for first 12 months (5GB free)',
      warnings: [
        '💰 You will be charged by AWS starting immediately',
        '🌍 Bucket name must be globally unique',
        '🗑️ Delete all objects before deleting bucket',
        '💵 Data transfer costs $0.09/GB after 100GB/month',
        '🔄 Run "terraform destroy" when done'
      ]
    };
  }

  // Default
  return {
    resourceType: 'unknown',
    resourceConfig: {},
    summary: 'Please specify what AWS resource you want to create.',
    terraformCode: '# Specify resource type',
    plan: 'No plan available',
    resources: [],
    estimatedCost: 'Unknown',
    warnings: ['Specify a valid resource type']
  };
}

// ACTUALLY CREATE AWS RESOURCES USING AWS SDK
async function createAWSResource(resourceType, config, credentials) {
  console.log('🔨 Creating resource:', resourceType);
  
  if (resourceType === 's3-bucket') {
    return await createS3Bucket(config, credentials);
  }
  
  throw new Error(`Unsupported resource type: ${resourceType}`);
}

async function createS3Bucket(config, credentials) {
  const s3 = new AWS.S3({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    region: 'us-east-1'
  });

  try {
    // Create bucket
    console.log('📦 Creating S3 bucket:', config.bucketName);
    
    const createParams = {
      Bucket: config.bucketName,
      ObjectOwnership: 'BucketOwnerEnforced'
    };

    await s3.createBucket(createParams).promise();
    console.log('✅ Bucket created');

    // Enable versioning
    console.log('🔄 Enabling versioning...');
    await s3.putBucketVersioning({
      Bucket: config.bucketName,
      VersioningConfiguration: {
        Status: 'Enabled'
      }
    }).promise();
    console.log('✅ Versioning enabled');

    // Enable encryption
    console.log('🔒 Enabling encryption...');
    await s3.putBucketEncryption({
      Bucket: config.bucketName,
      ServerSideEncryptionConfiguration: {
        Rules: [{
          ApplyServerSideEncryptionByDefault: {
            SSEAlgorithm: 'AES256'
          }
        }]
      }
    }).promise();
    console.log('✅ Encryption enabled');

    // Add tags
    console.log('🏷️ Adding tags...');
    await s3.putBucketTagging({
      Bucket: config.bucketName,
      Tagging: {
        TagSet: [
          { Key: 'Name', Value: 'Terraform AI Bucket' },
          { Key: 'Environment', Value: 'Development' },
          { Key: 'ManagedBy', Value: 'TerraformAI' },
          { Key: 'CreatedAt', Value: new Date().toISOString() }
        ]
      }
    }).promise();
    console.log('✅ Tags added');

    const bucketUrl = `https://s3.console.aws.amazon.com/s3/buckets/${config.bucketName}`;

    return {
      resourceId: config.bucketName,
      message: `✅ Successfully created S3 bucket!\n\n📦 Bucket Name: ${config.bucketName}\n🔗 View in Console: ${bucketUrl}\n\n✨ Features enabled:\n• Versioning\n• Server-side encryption (AES256)\n• Management tags\n\n💡 Your bucket is ready to use!`,
      outputs: {
        bucket_name: config.bucketName,
        bucket_region: 'us-east-1',
        bucket_arn: `arn:aws:s3:::${config.bucketName}`,
        console_url: bucketUrl,
        created_at: new Date().toISOString()
      }
    };

  } catch (error) {
    console.error('❌ S3 creation failed:', error);
    
    if (error.code === 'BucketAlreadyExists') {
      throw new Error(`Bucket name "${config.bucketName}" is already taken globally. S3 bucket names must be unique across all AWS accounts.`);
    }
    
    if (error.code === 'InvalidBucketName') {
      throw new Error(`Invalid bucket name "${config.bucketName}". Bucket names must be 3-63 characters, lowercase, and contain only letters, numbers, and hyphens.`);
    }
    
    throw new Error(`Failed to create S3 bucket: ${error.message}`);
  }
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