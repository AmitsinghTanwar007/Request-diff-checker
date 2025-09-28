# Request-diff-checker

This tool can be used to check differences between two HTTP calls by making requests to both endpoints and comparing their responses.

## Installation

```bash
npm install
```

## Usage

```bash
npm start [URL1] [URL2]
```

### Examples

```bash
# Compare two different API endpoints
npm start https://api.example.com/users/1 https://api.example.com/users/2

# Compare different versions of the same endpoint
npm start https://api.v1.example.com/data https://api.v2.example.com/data

# Show help
npm start -- --help
```

## Features

- Makes HTTP requests to two URLs
- Compares the responses and shows differences
- Supports different HTTP methods and options
- Color-coded diff output for easy visualization
- Error handling for network issues

## Output

The tool will display:
- The requests being made
- A colored diff showing additions (+) and removals (-)
- A summary with HTTP status codes and whether differences were found
