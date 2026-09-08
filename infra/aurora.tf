# The database: Aurora Serverless v2 Postgres with min capacity 0.
#
# WHY THIS ENGINE: the pause-for-weeks requirement kills plain RDS — a stopped RDS instance
# auto-restarts after 7 days and silently resumes billing, which is precisely the failure
# mode of "back in six weeks". Serverless v2 at min ACU 0 suspends *itself* after idle and
# wakes on the first query (~15s, eaten by whoever opens the site on Thursday before a race).
#
# WHY A PUBLIC ENDPOINT, stated plainly because it is the least obvious call here:
# private subnets would force App Runner onto a VPC connector, which routes *all* of the
# app's egress — including every QuickBooks API call — through the VPC, and that traffic
# then needs an always-on NAT gateway (~$32/mo, unpausable). It would also strand the
# operator's laptop, which is what runs pg_dump backups, restore drills, and `npm run auth`.
# Compensating controls: TLS is *forced* (parameter group below, verified against the RDS CA
# bundle baked into the image), the password is 32 random characters managed by RDS in
# Secrets Manager (never in Terraform state), and `db_ingress_cidrs` exists to narrow :5432
# to known networks. This is the Neon/Supabase posture, not an accident.
# The hardening path, if it is ever wanted: private subnets + VPC connector + NAT, and a
# bastion or SSM tunnel for the laptop jobs. Nothing below forecloses it.

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/24"
  enable_dns_hostnames = true
  tags                 = { Name = "rpg" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

data "aws_availability_zones" "available" {
  state = "available"
}

# Two subnets because a DB subnet group demands two AZs, even for one instance.
resource "aws_subnet" "db" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 2, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "rpg-db-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "db" {
  count          = 2
  subnet_id      = aws_subnet.db[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_db_subnet_group" "main" {
  name       = "rpg"
  subnet_ids = aws_subnet.db[*].id
}

resource "aws_security_group" "db" {
  name        = "rpg-db"
  description = "Postgres, TLS-only, from the CIDRs in db_ingress_cidrs"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "postgres"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.db_ingress_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# rds.force_ssl is what turns "public endpoint" from reckless into a posture: a client that
# will not do TLS does not get a session, password or no password.
resource "aws_rds_cluster_parameter_group" "main" {
  name   = "rpg-aurora-pg16"
  family = "aurora-postgresql16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "aws_rds_cluster" "main" {
  cluster_identifier = "rpg"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned" # serverless v2 uses provisioned mode + the scaling block
  engine_version     = "16.6"        # min-ACU-0 auto-pause needs 16.3+; do not downgrade past it
  database_name      = "racing"
  master_username    = "racing"
  # RDS generates and holds the password in Secrets Manager. It never exists in Terraform
  # state or in this repo; DATABASE_URL is assembled from it once, into SSM (docs/deploy.md).
  manage_master_user_password     = true
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.main.name
  storage_encrypted               = true

  # Backup layer 1: continuous PITR, at the maximum retention RDS offers. Layer 2 and 3 are
  # the dump bucket (s3-backups.tf) written by infra/scripts/backup.sh.
  backup_retention_period = 35
  preferred_backup_window = "09:00-10:00" # 01:00-02:00 Pacific: never a race session

  serverlessv2_scaling_configuration {
    min_capacity             = 0 # the whole point: zero compute between races
    max_capacity             = 1 # a paddock of phones; raise only with evidence
    seconds_until_auto_pause = 1800
  }

  # Two locks against losing the data to an operator mistake rather than a disaster:
  # `terraform destroy` refuses while deletion_protection is set, and even a forced deletion
  # must write a final snapshot first.
  deletion_protection       = true
  final_snapshot_identifier = "rpg-final"
  skip_final_snapshot       = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_rds_cluster_instance" "main" {
  identifier          = "rpg-1"
  cluster_identifier  = aws_rds_cluster.main.id
  engine              = aws_rds_cluster.main.engine
  engine_version      = aws_rds_cluster.main.engine_version
  instance_class      = "db.serverless"
  publicly_accessible = true
}
