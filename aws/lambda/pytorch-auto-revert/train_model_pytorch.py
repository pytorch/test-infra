import pandas as pd
import ast
import numpy as np
import datetime
import joblib
from collections import defaultdict
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import MultiLabelBinarizer
from sklearn.metrics import precision_score, recall_score, f1_score
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset

# Set random seed for reproducibility
torch.manual_seed(42)
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f"Using device: {device}")

# Load CSV
print("Loading dataset...")
df = pd.read_csv("autorevert_patterns.csv")

# variables that are array
df["newer_failure_rules"] = df["newer_failure_rules"].apply(ast.literal_eval)

# Create failure_job combination field
df["failure_job"] = df["failure_rule"] + "||" + df["job_name"]

# Group by SHA to enable many-hot encoding for categorical features
print("\nGrouping by SHA to generate improved features...")
sha_groups = df.groupby('sha')

# Process categorical features using many-hot encoding approach
categorical_features = ["failure_rule", "job_name", "workflow_name", "failure_job"]
boolean_features = ["repeated_failure"]

# Create dictionaries to store the unique values for each SHA
sha_categorical_values = defaultdict(lambda: defaultdict(set))
sha_newer_failure_rules = defaultdict(set)
sha_failure_newer = defaultdict(set)

# Collect all values per SHA
for sha, group in sha_groups:
    # Handle categorical features
    for feature in categorical_features:
        values = group[feature].unique()
        sha_categorical_values[sha][feature].update(values)

    # Handle newer_failure_rules (already a list in each row)
    for _, row in group.iterrows():
        sha_newer_failure_rules[sha].update(row["newer_failure_rules"])

    # Process each row for this SHA and create failure_newer combinations based on that row's failure_rule
    for _, row in group.iterrows():
        failure_rule = row["failure_rule"]
        for newer_rule in row["newer_failure_rules"]:
            sha_failure_newer[sha].add(f"{failure_rule}||{newer_rule}")

# Create new DataFrame with one row per SHA
improved_rows = []

for sha, groups in sha_groups:
    # Get the target value (is_reverted_non_ghfirst)
    # All rows for the same SHA should have the same target value
    is_reverted = groups['is_reverted_non_ghfirst'].iloc[0]
    is_reverted_simple = groups['is_reverted'].iloc[0]

    # Get all categorical values for this SHA
    feature_values = {}
    for feature in categorical_features:
        feature_values[feature] = list(sha_categorical_values[sha][feature])

    # Get all newer_failure_rules for this SHA
    newer_failure_rules = list(sha_newer_failure_rules[sha])

    # Get all failure_newer combinations for this SHA
    failure_newer = list(sha_failure_newer[sha])

    # Get repeated_failure status - if any row has repeated_failure=True, set it to True
    repeated_failure = groups['repeated_failure'].any()

    # Create a new row
    row = {
        'sha': sha,
        'is_reverted': is_reverted_simple,
        'is_reverted_non_ghfirst': is_reverted,
        'failure_rule': feature_values['failure_rule'],
        'job_name': feature_values['job_name'],
        'workflow_name': feature_values['workflow_name'],
        'failure_job': feature_values['failure_job'],
        'repeated_failure': repeated_failure,
        'newer_failure_rules': newer_failure_rules,
        'failure_newer': failure_newer
    }
    improved_rows.append(row)

# Create new DataFrame with the improved features
print(f"Created {len(improved_rows)} rows with aggregated features (one per SHA)")
improved_df = pd.DataFrame(improved_rows)

# Calculate failure rarity metrics from the original dataframe
print("\nGenerating rarity bucket features...")

# Count occurrences of each failure rule in the original dataset
failure_counts = df["failure_rule"].value_counts()
total_failures = len(df)

# Calculate rarity scores (inverse of frequency)
failure_rarity = 1 / (failure_counts / total_failures)
failure_rarity = failure_rarity / failure_rarity.max()  # Normalize to 0-1

# Calculate failure-job combination rarity
failure_job_counts = df["failure_job"].value_counts()
failure_job_rarity = 1 / (failure_job_counts / total_failures)
failure_job_rarity = failure_job_rarity / failure_job_rarity.max()  # Normalize to 0-1

# Create quantile-based buckets for rarity values (10 buckets)
print("Creating quantile-based rarity buckets...")
NUM_BUCKETS = 20

# Extract all rarity values from the original dataset
failure_rule_rarities = [failure_rarity[rule] for rule in df["failure_rule"]]
failure_job_rarities = [failure_job_rarity[job] for job in df["failure_job"]]

# Create quantile-based bucket edges
failure_rule_bucket_edges = np.quantile(failure_rule_rarities, np.linspace(0, 1, NUM_BUCKETS+1))
failure_job_bucket_edges = np.quantile(failure_job_rarities, np.linspace(0, 1, NUM_BUCKETS+1))

# Ensure the first edge is 0 and the last edge is slightly above the maximum value
failure_rule_bucket_edges[0] = 0
failure_rule_bucket_edges[-1] = max(failure_rule_rarities) * 1.001

failure_job_bucket_edges[0] = 0
failure_job_bucket_edges[-1] = max(failure_job_rarities) * 1.001

print(f"Rule rarity bucket edges: {failure_rule_bucket_edges}")
print(f"Job rarity bucket edges: {failure_job_bucket_edges}")

# Function to assign a value to a bucket
def get_bucket(value, edges):
    for i in range(len(edges)-1):
        if edges[i] <= value < edges[i+1]:
            return i
    return len(edges)-2  # Last bucket for value == 1

# Map rarity values to bucket indexes
failure_rule_buckets = {rule: get_bucket(rarity, failure_rule_bucket_edges)
                       for rule, rarity in failure_rarity.items()}
failure_job_buckets = {job: get_bucket(rarity, failure_job_bucket_edges)
                      for job, rarity in failure_job_rarity.items()}

# Create binary features for each rarity bucket
# Each SHA gets a 1 for each bucket that any of its failure_rules or failure_jobs fall into
rarity_bucket_cols_rule = [f"failure_rule_bucket_{i}" for i in range(NUM_BUCKETS)]
rarity_bucket_cols_job = [f"failure_job_bucket_{i}" for i in range(NUM_BUCKETS)]

# Initialize bucket columns with zeros
for col in rarity_bucket_cols_rule + rarity_bucket_cols_job:
    improved_df[col] = 0

# Fill bucket columns with 1s when a SHA has a failure_rule or failure_job in that bucket
for i, row in improved_df.iterrows():
    sha = row['sha']

    # Set bucket features for failure rules
    buckets_seen_rule = set()
    for failure_rule in row['failure_rule']:
        if failure_rule in failure_rule_buckets:
            bucket = failure_rule_buckets[failure_rule]
            buckets_seen_rule.add(bucket)

    for bucket in buckets_seen_rule:
        improved_df.at[i, f"failure_rule_bucket_{bucket}"] = 1

    # Set bucket features for failure jobs
    buckets_seen_job = set()
    for failure_job in row['failure_job']:
        if failure_job in failure_job_buckets:
            bucket = failure_job_buckets[failure_job]
            buckets_seen_job.add(bucket)

    for bucket in buckets_seen_job:
        improved_df.at[i, f"failure_job_bucket_{bucket}"] = 1

print(f"Created {NUM_BUCKETS} rarity bucket features for failure rules and {NUM_BUCKETS} for failure jobs")

# Create clean dataset for training by removing unnecessary columns
train_df = improved_df.drop(columns=['sha', 'is_reverted'])

print("\nSample data:")
print(train_df.head())
print(train_df.info())

# Target and input features
y = train_df["is_reverted_non_ghfirst"]
X = train_df.drop(columns=["is_reverted_non_ghfirst"])

# Setup multi-label binarizers for all categorical features
mlbs = {}
binary_dfs = {}

print("\nCreating binary features for categorical lists...")
# Process each categorical feature that's now a list
for feature in categorical_features:
    mlb = MultiLabelBinarizer()
    binary_matrix = mlb.fit_transform(X[feature])

    # Use actual category values in column names for better interpretability
    feature_names = [f"{feature}_{value}" for value in mlb.classes_]

    binary_df = pd.DataFrame(
        binary_matrix,
        columns=feature_names,
        index=X.index
    )

    mlbs[feature] = mlb
    binary_dfs[feature] = binary_df
    print(f"Created {len(feature_names)} binary features for {feature}")

# Handle newer_failure_rules
mlb_rules = MultiLabelBinarizer()
rules_binary = mlb_rules.fit_transform(X["newer_failure_rules"])

# Use actual rule values in column names
rules_names = [f"rule_{rule}" for rule in mlb_rules.classes_]
rules_df = pd.DataFrame(
    rules_binary,
    columns=rules_names,
    index=X.index
)
print(f"Created {len(rules_names)} binary features for newer_failure_rules")

# Handle failure_newer combinations
mlb_failure_newer = MultiLabelBinarizer()
failure_newer_binary = mlb_failure_newer.fit_transform(X["failure_newer"])

# Use indices for failure_combo since the values might be too long for column names
failure_combo_names = [f"failure_combo_{i}" for i in range(failure_newer_binary.shape[1])]
failure_combo_df = pd.DataFrame(
    failure_newer_binary,
    columns=failure_combo_names,
    index=X.index
)
print(f"Created {len(failure_combo_names)} binary features for failure_newer")

# Drop the original list columns and create a clean feature dataframe
X = X.drop(columns=[feature for feature in categorical_features] + ["newer_failure_rules", "failure_newer"])

# Concatenate all binary dataframes and the remaining features
feature_dfs = [X] + list(binary_dfs.values()) + [rules_df, failure_combo_df]
X = pd.concat(feature_dfs, axis=1)

# Add a bias term (intercept column)
X['intercept'] = 1.0

print(f"\nFinal dataset dimensions: {X.shape}")

# Train/test split
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

print(f"Training set dimensions: {X_train.shape}")
print(f"Testing set dimensions: {X_test.shape}")

# Ensure all data is numeric and handle problematic values
print("\nCleaning data for tensor conversion...")

# Convert entire DataFrame to float directly
try:
    X_train = X_train.astype(float)
    X_test = X_test.astype(float)
    print("Successfully converted all data to float")
except ValueError as e:
    print(f"Error converting all columns at once: {e}")
    print("Trying column by column approach...")

    # If that fails, go column by column and drop problematic ones
    for col in X_train.columns:
        try:
            X_train[col] = X_train[col].astype(float)
            X_test[col] = X_test[col].astype(float)
        except (ValueError, TypeError) as e:
            print(f"Dropping column {col} due to conversion error: {e}")
            # Drop this problematic column
            X_train = X_train.drop(columns=[col])
            X_test = X_test.drop(columns=[col])

# Fill any NaN values with 0
if X_train.isna().any().any() or X_test.isna().any().any():
    print("Filling NaN values with 0")
    X_train = X_train.fillna(0)
    X_test = X_test.fillna(0)

# Final check - display dtypes
print("\nData types after cleaning:")
print(X_train.dtypes.value_counts())

# Double-check no object dtypes remain
object_cols = X_train.select_dtypes(include=['object']).columns.tolist()
if object_cols:
    print(f"WARNING: {len(object_cols)} object columns remain. Dropping them.")
    X_train = X_train.drop(columns=object_cols)
    X_test = X_test.drop(columns=object_cols)

print(f"Final cleaned shapes - X_train: {X_train.shape}, X_test: {X_test.shape}")

# Convert data to PyTorch tensors with additional error handling
print("\nConverting to PyTorch tensors...")
try:
    # First convert to numpy arrays with explicit float32 dtype
    X_train_np = X_train.values.astype(np.float32)
    y_train_np = y_train.values.astype(np.float32)
    X_test_np = X_test.values.astype(np.float32)
    y_test_np = y_test.values.astype(np.float32)

    # Now convert to tensors
    X_train_tensor = torch.from_numpy(X_train_np).to(device)
    y_train_tensor = torch.from_numpy(y_train_np).to(device)
    X_test_tensor = torch.from_numpy(X_test_np).to(device)
    y_test_tensor = torch.from_numpy(y_test_np).to(device)

    print("Successfully converted data to tensors")
except Exception as e:
    print(f"Error during tensor conversion: {e}")
    raise

# Create PyTorch datasets and dataloaders
train_dataset = TensorDataset(X_train_tensor, y_train_tensor)
test_dataset = TensorDataset(X_test_tensor, y_test_tensor)

# Increased batch size for better pattern recognition
batch_size = 200
train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
test_loader = DataLoader(test_dataset, batch_size=batch_size, shuffle=False)

# Define PyTorch model - kernel SVM with RBF kernel
class KernelSVM(nn.Module):
    def __init__(self, input_dim, num_support_vectors=100, gamma=0.01):
        super(KernelSVM, self).__init__()

        # Number of support vectors to use (randomly initialized and learned)
        self.num_support_vectors = num_support_vectors

        # Gamma parameter for RBF kernel (controls the 'width' of the Gaussian)
        self.gamma = gamma

        # Initialize support vectors randomly from N(0, 0.1)
        # These will be learned during training
        self.support_vectors = nn.Parameter(torch.randn(num_support_vectors, input_dim) * 0.1)

        # Initialize weights for each support vector
        self.weights = nn.Parameter(torch.randn(num_support_vectors, 1) * 0.01)

        # Initialize bias
        self.bias = nn.Parameter(torch.zeros(1))

    def rbf_kernel(self, x, support_vectors):
        # Calculate squared Euclidean distance between each pair of points
        # Shape: [batch_size, num_support_vectors]
        batch_size = x.size(0)
        x_norm = torch.sum(x**2, dim=1).view(batch_size, 1)
        sv_norm = torch.sum(support_vectors**2, dim=1).view(1, self.num_support_vectors)

        # ||x-y||² = ||x||² + ||y||² - 2*x·y
        distances = x_norm + sv_norm - 2.0 * torch.mm(x, support_vectors.t())

        # RBF kernel: K(x,y) = exp(-gamma * ||x-y||²)
        kernel_values = torch.exp(-self.gamma * distances)
        return kernel_values

    def forward(self, x):
        # Apply RBF kernel between input and support vectors
        # Output shape: [batch_size, num_support_vectors]
        kernel_outputs = self.rbf_kernel(x, self.support_vectors)

        # Calculate final output: sum(kernel_outputs * weights) + bias
        # Shape: [batch_size, 1]
        outputs = torch.mm(kernel_outputs, self.weights) + self.bias

        return outputs

# Set input dimension based on the number of features
input_dim = X_train.shape[1]

# Create kernel SVM model with appropriate hyperparameters
# - num_support_vectors: controls model capacity (higher = more complex model)
# - gamma: controls the width of the Gaussian kernel (higher = narrower kernels)
model = KernelSVM(
    input_dim=input_dim,
    num_support_vectors=min(200, int(X_train.shape[0] * 0.1)),  # Use 10% of training samples or max 200
    gamma=0.01  # Start with moderate gamma value
).to(device)

# Define hinge loss for SVM
class HingeLoss(nn.Module):
    def __init__(self, class_weight=None):
        super(HingeLoss, self).__init__()
        self.class_weight = class_weight

    def forward(self, outputs, targets):
        # Convert binary targets from 0/1 to -1/1 as required for SVM
        targets = 2 * targets - 1
        # Calculate hinge loss: max(0, 1 - y * f(x))
        loss = torch.max(torch.zeros_like(outputs), 1 - targets * outputs)

        # Apply class weights if provided
        if self.class_weight is not None:
            weight_mask = torch.ones_like(targets)
            weight_mask[targets > 0] = self.class_weight
            loss = loss * weight_mask

        return loss.mean()

# Calculate class weight for imbalanced dataset
pos_weight = sum(1-y_train.values)/sum(y_train.values)
criterion = HingeLoss(class_weight=pos_weight)

# Use Adam optimizer for kernel SVM - better for optimizing the support vectors
# - Adaptive learning rates per parameter
# - Momentum-based optimization built-in
# - Lower learning rate for stability with complex kernel calculations
optimizer = optim.Adam(
    model.parameters(),
    lr=0.001,              # Lower learning rate for stability
    betas=(0.9, 0.999),    # Default momentum parameters
    weight_decay=1e-4      # L2 regularization to prevent overfitting
)

# Learning rate scheduler with warm restarts for kernel SVM
# Slightly longer initial period to allow more exploration of support vector space
scheduler = optim.lr_scheduler.CosineAnnealingWarmRestarts(
    optimizer,
    T_0=30,        # Initial restart period (longer for kernel SVM)
    T_mult=2,      # Increase period after each restart
    eta_min=1e-6   # Lower minimum learning rate
)

# Training function optimized for kernel SVM with memory management
def train_model(model, train_loader, criterion, optimizer, epochs=2000):
    model.train()
    epoch_losses = []
    best_val_loss = float('inf')
    patience = 50  # Allow more epochs without improvement before early stopping
    patience_counter = 0
    no_improvement_threshold = 0.00001  # Minimum improvement to reset patience counter

    for epoch in range(epochs):
        running_loss = 0.0
        for inputs, labels in train_loader:
            optimizer.zero_grad()

            # Forward pass with SVM
            outputs = model(inputs).squeeze()
            loss = criterion(outputs, labels)

            # Backward pass and optimize
            loss.backward()
            optimizer.step()

            # Accumulate loss
            running_loss += loss.item() * inputs.size(0)

        # Update learning rate with cosine schedule (each epoch)
        scheduler.step()

        epoch_loss = running_loss / len(train_loader.dataset)
        epoch_losses.append(epoch_loss)

        # Print statistics more frequently to monitor training
        if (epoch + 1) % 5 == 0:
            print(f"Epoch {epoch+1}/{epochs}, Loss: {epoch_loss:.4f}, LR: {optimizer.param_groups[0]['lr']:.2e}")

                # Calculate validation loss
            val_loss = validate_model(model, test_loader, criterion)

            # Log support vector norms for diagnostic purposes
            if hasattr(model, 'support_vectors'):
                sv_norm = torch.norm(model.support_vectors, dim=1).mean().item()
                w_norm = torch.norm(model.weights).item()
                print(f"    Support vector avg norm: {sv_norm:.4f}, Weight norm: {w_norm:.4f}")

            # Early stopping with patience
            if val_loss < best_val_loss * (1 - no_improvement_threshold):
                best_val_loss = val_loss
                patience_counter = 0
            else:
                patience_counter += 1

            if patience_counter >= patience:
                print(f"No improvement for {patience} epochs. Early stopping.")
                break

    return epoch_losses

# Validation function
def validate_model(model, test_loader, criterion):
    model.eval()
    running_loss = 0.0

    with torch.no_grad():
        for inputs, labels in test_loader:
            outputs = model(inputs).squeeze()
            loss = criterion(outputs, labels)
            running_loss += loss.item() * inputs.size(0)

    return running_loss / len(test_loader.dataset)

# Function to evaluate model performance
def evaluate_model(model, X_tensor, y_tensor, threshold=0.5):
    model.eval()
    with torch.no_grad():
        # Use batching for kernel SVM to avoid memory issues
        batch_size = 500
        num_samples = X_tensor.shape[0]
        y_pred_logits = []

        # Process in batches for kernel method memory efficiency
        for i in range(0, num_samples, batch_size):
            batch_end = min(i + batch_size, num_samples)
            batch_output = model(X_tensor[i:batch_end]).squeeze().cpu().numpy()
            y_pred_logits.append(batch_output)

        # Combine batch results
        y_pred_logits = np.concatenate(y_pred_logits)
        y_pred_proba = 1 / (1 + np.exp(-y_pred_logits))  # sigmoid
        y_pred = (y_pred_proba >= threshold).astype(int)
        y_true = y_tensor.cpu().numpy()

        precision = precision_score(y_true, y_pred, zero_division=0)
        recall = recall_score(y_true, y_pred, zero_division=0)
        f1 = f1_score(y_true, y_pred, zero_division=0)

        return {
            'threshold': threshold,
            'precision': precision,
            'recall': recall,
            'f1': f1,
            'probabilities': y_pred_proba
        }

# Function to find the optimal threshold for F1 score
def find_optimal_threshold(model, X_tensor, y_tensor):
    model.eval()
    with torch.no_grad():
        # Use batching for kernel SVM to avoid memory issues
        batch_size = 500
        num_samples = X_tensor.shape[0]
        y_pred_logits = []

        # Process in batches for kernel method memory efficiency
        for i in range(0, num_samples, batch_size):
            batch_end = min(i + batch_size, num_samples)
            batch_output = model(X_tensor[i:batch_end]).squeeze().cpu().numpy()
            y_pred_logits.append(batch_output)

        # Combine batch results
        y_pred_logits = np.concatenate(y_pred_logits)
        y_pred_proba = 1 / (1 + np.exp(-y_pred_logits))  # sigmoid
        y_true = y_tensor.cpu().numpy()

        thresholds = [i/100 for i in range(1, 100)]
        best_f1 = 0
        best_threshold = 0.5
        threshold_results = []

        for threshold in thresholds:
            y_pred = (y_pred_proba >= threshold).astype(int)
            precision = precision_score(y_true, y_pred, zero_division=0)
            recall = recall_score(y_true, y_pred, zero_division=0)
            f1 = f1_score(y_true, y_pred, zero_division=0)
            threshold_results.append((threshold, precision, recall, f1))

            if f1 > best_f1:
                best_f1 = f1
                best_threshold = threshold

        return best_threshold, threshold_results

# Print class distribution for sanity check
print("\nClass distribution:")
print(f"Training: {y_train.value_counts()}")
print(f"Testing: {y_test.value_counts()}")

# Train the model
print("\nTraining PyTorch kernel SVM model...")

# Clear CUDA cache if using GPU to free memory before training
if torch.cuda.is_available():
    torch.cuda.empty_cache()

# Run training with smaller epoch limit for kernel SVM (more compute-intensive)
train_losses = train_model(model, train_loader, criterion, optimizer, epochs=2000)

# Evaluate on test set
print("\nEvaluating model on test set...")
best_threshold, threshold_results = find_optimal_threshold(model, X_test_tensor, y_test_tensor)

print(f"\nOptimal threshold: {best_threshold:.4f}")
print("\nSelected threshold results:")
selected_thresholds = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
for threshold, precision, recall, f1 in threshold_results:
    if abs(threshold - round(threshold, 1)) < 0.001:
        print(f"Threshold {threshold:.1f}: Precision {precision:.4f}, Recall {recall:.4f}, F1 {f1:.4f}")

# Final evaluation with optimal threshold
test_metrics = evaluate_model(model, X_test_tensor, y_test_tensor, threshold=best_threshold)
print(f"\nOptimal threshold ({best_threshold:.4f}) metrics:")
print(f"Testing Precision: {test_metrics['precision']:.4f}")
print(f"Testing Recall: {test_metrics['recall']:.4f}")
print(f"Testing F1 Score: {test_metrics['f1']:.4f}")
print(f"Predictions sum: {sum((test_metrics['probabilities'] >= best_threshold).astype(int))}, Total: {len(test_metrics['probabilities'])}")

# Standard evaluation with default threshold (0.5)
default_metrics = evaluate_model(model, X_test_tensor, y_test_tensor, threshold=0.5)
print(f"\nDefault threshold (0.5) metrics:")
print(f"Testing Precision: {default_metrics['precision']:.4f}")
print(f"Testing Recall: {default_metrics['recall']:.4f}")
print(f"Testing F1 Score: {default_metrics['f1']:.4f}")
print(f"Predictions sum: {sum((default_metrics['probabilities'] >= 0.5).astype(int))}, Total: {len(default_metrics['probabilities'])}")

# Save the model and metadata for production use
print("\nSaving kernel SVM model and metadata...")

# Save the PyTorch model using torch.save instead of joblib
torch.save(model.state_dict(), "kernel_svm_model.pt")

# Save additional model configuration as metadata
metadata = {
    'input_dim': input_dim,
    'num_support_vectors': model.num_support_vectors,
    'gamma': model.gamma,
    'optimal_threshold': best_threshold,
    'model_type': 'KernelSVM',
    'feature_columns': X_train.columns.tolist(),
    'categorical_features': categorical_features,
    'mlbs': mlbs,
    'mlb_rules': mlb_rules,
    'mlb_failure_newer': mlb_failure_newer,
    'feature_names': {
        'failure_combo': failure_combo_names,
        'rules': rules_names
    },
    'bucket_info': {
        'failure_rule_bucket_edges': failure_rule_bucket_edges.tolist(),
        'failure_job_bucket_edges': failure_job_bucket_edges.tolist(),
        'failure_rule_buckets': failure_rule_buckets,
        'failure_job_buckets': failure_job_buckets,
        'num_buckets': NUM_BUCKETS
    },
    'optimizer_config': {
        'name': 'Adam',
        'lr': 0.001,
        'betas': (0.9, 0.999),
        'weight_decay': 1e-4
    },
    'created_at': datetime.datetime.now().isoformat(),
    'pytorch_version': torch.__version__
}

# Save metadata using joblib
joblib.dump(metadata, "kernel_svm_metadata.joblib")

print("Done. Model and metadata saved to disk.")
