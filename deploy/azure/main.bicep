// Aurex on Azure: one Ubuntu 24.04 VM running the app, Caddy (automatic HTTPS) and Litestream (continuous
// database backups to Blob Storage), with secrets in Key Vault. See README.md in this folder.
//
// After editing, rebuild the template the "Deploy to Azure" button uses:
//   bicep build main.bicep --outfile azuredeploy.json
metadata description = 'Aurex: P2P money, AI hub and AI trading on one Azure VM with HTTPS, backups and Key Vault'

@description('Your email. It becomes the admin account (sign up with it after setup) and gets HTTPS certificate notices.')
param adminEmail string

@description('Optional: your own domain, e.g. aurex.example.com. Leave empty to use the free address <name>.<region>.cloudapp.azure.com. For your own domain, add a DNS A record pointing at the public IP shown after deployment.')
param domainName string = ''

@description('Name for the free address <name>.<region>.cloudapp.azure.com (lowercase letters, digits and hyphens).')
@minLength(3)
@maxLength(63)
param dnsLabel string = 'aurex-${uniqueString(resourceGroup().id)}'

@description('Server size. B2ats_v2 (AMD), B2pts_v2 (Arm) and B1s include 750 free hours a month for the first 12 months of a new Azure account; they have 1 GiB of memory. B2als_v2 and B2pls_v2 have 4 GiB and are paid.')
@allowed([
  'Standard_B2ats_v2'
  'Standard_B2pts_v2'
  'Standard_B1s'
  'Standard_B2als_v2'
  'Standard_B2pls_v2'
  'Standard_B2s'
])
param vmSize string = 'Standard_B2ats_v2'

@description('Login name for the server. You rarely need it: Run command and Serial console in the portal work without SSH.')
param adminUsername string = 'aurexadmin'

@description('How you sign in to the server in an emergency (Serial console or SSH).')
@allowed([
  'password'
  'sshPublicKey'
])
param authenticationType string = 'password'

@description('A password (12+ characters with upper and lower case letters, a digit and a symbol) or an SSH public key.')
@secure()
@minLength(12)
param adminPasswordOrKey string

@description('Optional: an IP range allowed to SSH in, e.g. 203.0.113.4/32. Leave empty to keep SSH closed.')
param sshSourceCidr string = ''

@description('Payment methods to enable. "sandbox" uses test money; add real providers later in /opt/aurex/src/deploy/server/.env.')
param paymentRails string = 'sandbox'

@description('Git repository to install from.')
param repositoryUrl string = 'https://github.com/pizzatechies/P2P.git'

@description('Branch to install.')
param branch string = 'claude/gifted-ritchie-8xzdk9'

@description('Disk size in GB. A 64 GB Premium SSD (P6) is part of the free services for 12 months.')
@minValue(30)
@maxValue(1024)
param osDiskSizeGB int = 64

@description('Region for every resource. Defaults to the resource group\'s region.')
param location string = resourceGroup().location

var suffix = uniqueString(resourceGroup().id)
var isArm = contains(['Standard_B2pts_v2', 'Standard_B2pls_v2'], vmSize)
var keyVaultName = 'aurex-${suffix}'
var storageAccountName = 'aurex${suffix}'
var backupContainerName = 'backups'
var sshOpen = !empty(sshSourceCidr)
var domain = empty(domainName) ? publicIp.properties.dnsSettings.fqdn : domainName

// Built-in roles: https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/security
var keyVaultSecretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

var webRules = [
  {
    name: 'web'
    properties: {
      description: 'HTTP (redirects to HTTPS and proves the domain for certificates) and HTTPS'
      priority: 100
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: 'Internet'
      sourcePortRange: '*'
      destinationAddressPrefix: '*'
      destinationPortRanges: ['80', '443']
    }
  }
  {
    name: 'http3'
    properties: {
      description: 'HTTP/3'
      priority: 110
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Udp'
      sourceAddressPrefix: 'Internet'
      sourcePortRange: '*'
      destinationAddressPrefix: '*'
      destinationPortRange: '443'
    }
  }
]
var sshRules = sshOpen
  ? [
      {
        name: 'ssh'
        properties: {
          description: 'SSH from your IP range only'
          priority: 120
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: sshSourceCidr
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '22'
        }
      }
    ]
  : []

resource nsg 'Microsoft.Network/networkSecurityGroups@2025-05-01' = {
  name: 'aurex-nsg'
  location: location
  properties: {
    securityRules: concat(webRules, sshRules)
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2025-05-01' = {
  name: 'aurex-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: ['10.20.0.0/16']
    }
    subnets: [
      {
        name: 'default'
        properties: {
          addressPrefix: '10.20.1.0/24'
          networkSecurityGroup: {
            id: nsg.id
          }
          // Lets the storage firewall admit this subnet only (backups can't be read from anywhere else).
          serviceEndpoints: [
            {
              service: 'Microsoft.Storage'
            }
          ]
        }
      }
    ]
  }
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2025-05-01' existing = {
  parent: vnet
  name: 'default'
}

resource publicIp 'Microsoft.Network/publicIPAddresses@2025-05-01' = {
  name: 'aurex-ip'
  location: location
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: {
      domainNameLabel: dnsLabel
    }
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2025-05-01' = {
  name: 'aurex-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: subnet.id
          }
          publicIPAddress: {
            id: publicIp.id
          }
        }
      }
    ]
  }
}

// Database backups (Litestream). Private, HTTPS only, reachable only from the server's subnet.
resource storage 'Microsoft.Storage/storageAccounts@2025-06-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: true // Litestream signs its requests with the account key
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      virtualNetworkRules: [
        {
          id: subnet.id
          action: 'Allow'
        }
      ]
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 14
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 14
    }
  }
}

resource backupContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = {
  parent: blobService
  name: backupContainerName
  properties: {
    publicAccess: 'None'
  }
}

// MASTER-KEY and ADMIN-SETUP-CODE (written by the installer) and the storage key, so a rebuilt server
// can decrypt a restored database.
resource vault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

resource storageKeySecret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = {
  parent: vault
  name: 'STORAGE-KEY'
  properties: {
    contentType: 'Access key for storage account ${storage.name} (database backups)'
    value: storage.listKeys().keys[0].value
  }
}

var setupValues = {
  ADMIN_EMAIL: adminEmail
  DOMAIN: domain
  PAYMENT_RAILS: paymentRails
  KEY_VAULT: vault.name
  STORAGE_ACCOUNT: storage.name
  STORAGE_CONTAINER: backupContainerName
  REPOSITORY_URL: repositoryUrl
  BRANCH: branch
}
// Values go inside single quotes in the script, so single quotes are dropped from them.
var setupScript = reduce(
  items(setupValues),
  loadTextContent('cloud-init.sh'),
  (script, item) => replace(string(script), '{{${item.key}}}', replace(item.value, '\'', ''))
)

resource vm 'Microsoft.Compute/virtualMachines@2025-04-01' = {
  name: 'aurex-vm'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    osProfile: {
      computerName: 'aurex'
      adminUsername: adminUsername
      adminPassword: authenticationType == 'password' ? adminPasswordOrKey : null
      customData: base64(string(setupScript))
      linuxConfiguration: authenticationType == 'password'
        ? {
            disablePasswordAuthentication: false
            provisionVMAgent: true
          }
        : {
            disablePasswordAuthentication: true
            provisionVMAgent: true
            ssh: {
              publicKeys: [
                {
                  path: '/home/${adminUsername}/.ssh/authorized_keys'
                  keyData: adminPasswordOrKey
                }
              ]
            }
          }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: isArm ? 'server-arm64' : 'server'
        version: 'latest'
      }
      osDisk: {
        name: 'aurex-disk'
        createOption: 'FromImage'
        diskSizeGB: osDiskSizeGB
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
        deleteOption: 'Delete'
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
          properties: {
            deleteOption: 'Detach'
          }
        }
      ]
    }
    // Secure Boot and a virtual TPM (Trusted Launch) on the x64 sizes.
    securityProfile: isArm
      ? null
      : {
          securityType: 'TrustedLaunch'
          uefiSettings: {
            secureBootEnabled: true
            vTpmEnabled: true
          }
        }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true // needed for the Serial console
      }
    }
  }
  dependsOn: [
    storageKeySecret
    backupContainer
  ]
}

// The server reads and writes its secrets in the vault with its managed identity.
resource serverSecretsAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, vm.id, keyVaultSecretsOfficer)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficer)
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// You (whoever deploys) can read the secrets in the portal, e.g. the admin setup code.
resource deployerSecretsAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, deployer().objectId, keyVaultSecretsUser)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
    principalId: deployer().objectId
  }
}

@description('Your Aurex address. It goes live about 10-20 minutes after the deployment finishes (first build).')
output appUrl string = 'https://${domain}'

@description('The server\'s fixed public IP. Point your domain\'s A record here.')
output publicIp string = publicIp.properties.ipAddress

@description('The free Azure address of this server.')
output azureAddress string = publicIp.properties.dnsSettings.fqdn

@description('Where to find the admin setup code.')
output adminSetupCode string = 'Key Vault ${vault.name} > Objects > Secrets > ADMIN-SETUP-CODE'

@description('Where the database backups go.')
output backups string = 'Storage account ${storage.name}, container ${backupContainerName}, folder aurex'

@description('How to watch the setup, without SSH.')
output setupProgress string = 'Virtual machine aurex-vm > Operations > Run command > RunShellScript: tail -n 40 /var/log/aurex-install.log'

@description('SSH command (only if you allowed an IP range).')
output ssh string = sshOpen ? 'ssh ${adminUsername}@${publicIp.properties.ipAddress}' : 'SSH is closed. Use Run command or Serial console in the portal.'
